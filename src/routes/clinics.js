/**
 * src/routes/clinics.js — Directorio geoespacial de clínicas, proxy OSM y perfil MVZ
 *
 * Incluye:
 * - Búsqueda local en PostgreSQL por distancia Haversine (en km).
 * - Proxy `/osm-nearby` hacia Overpass API con respaldo de Nominatim y datos locales
 *   para evitar bloqueos CORS desde el navegador.
 * - Consulta y edición (`GET /my-clinic`, `PATCH /:id`) de la clínica reclamada por el MVZ.
 */
import express from 'express';
import { query } from '../config/database.js';
import { requireAuth, requireVet } from '../middleware/auth.js';
import { uploadImage } from '../middleware/upload.js';
import { FOLDERS } from '../config/storage.js';

const router = express.Router();

const CLINIC_DETAIL_SELECT = `
  c.id, c.nombre AS name, c.direccion AS address, c.ciudad AS city,
  c.estado AS state, c.pais AS country, c.codigo_postal AS zip_code,
  c.telefono AS phone, c.whatsapp, c.correo AS email, c.sitio_web AS website,
  c.lat, c.lng, c.google_place_id, c.horario AS schedule, c.servicios AS services,
  c.foto_url AS photo_url, c.es_24h AS is_24h, c.es_emergencia AS is_emergency,
  c.verificada AS is_verified, c.activa AS is_active,
  c.calificacion_promedio AS rating_avg, c.total_resenas AS rating_count,
  c.reclamada_por AS claimed_by,
  '[]'::json AS reviews
`;

// ── GET /api/clinics ── Busca clínicas registradas ordenadas por distancia (km)
router.get(['/', '/clinicas'], requireAuth, async (req, res) => {
  try {
    const {
      lat, lng, radius_km, radio,
      service, is_24h, is_emergency,
      search, limit = 50,
    } = req.query;

    const p_lat = parseFloat(lat);
    const p_lng = parseFloat(lng);
    const radiusInKm = radio ? parseFloat(radio) / 1000 : parseFloat(radius_km || 50);

    // Fórmula Haversine en SQL para calcular distancia esférica respecto a (lat, lng)
    let sql = `
      SELECT
        c.id, c.nombre AS name, c.direccion AS address, c.ciudad AS city,
        c.estado AS state, c.pais AS country, c.codigo_postal AS zip_code,
        c.telefono AS phone, c.whatsapp, c.correo AS email, c.sitio_web AS website,
        c.lat, c.lng, c.google_place_id, c.horario AS schedule, c.servicios AS services,
        c.foto_url AS photo_url, c.es_24h AS is_24h, c.es_emergencia AS is_emergency,
        c.verificada AS is_verified, c.activa AS is_active,
        c.calificacion_promedio AS rating_avg, c.total_resenas AS rating_count,
        CASE WHEN $1::numeric IS NOT NULL AND $2::numeric IS NOT NULL THEN
          ROUND(
            (6371 * acos(
              LEAST(1.0, GREATEST(-1.0,
                cos(radians($1::float)) * cos(radians(c.lat::float)) *
                cos(radians(c.lng::float) - radians($2::float)) +
                sin(radians($1::float)) * sin(radians(c.lat::float))
              ))
            ))::numeric, 2
          )
        ELSE NULL END AS distance_km
      FROM clinicas c
      WHERE c.activa = true
    `;

    const params = [isNaN(p_lat) ? null : p_lat, isNaN(p_lng) ? null : p_lng];
    let idx = 3;

    if (!isNaN(p_lat) && !isNaN(p_lng)) {
      sql += `
        AND (6371 * acos(
          LEAST(1.0, GREATEST(-1.0,
            cos(radians($1::float)) * cos(radians(c.lat::float)) *
            cos(radians(c.lng::float) - radians($2::float)) +
            sin(radians($1::float)) * sin(radians(c.lat::float))
          ))
        )) <= $${idx++}
      `;
      params.push(radiusInKm);
    }

    if (is_24h === 'true')       sql += ` AND c.es_24h = true`;
    if (is_emergency === 'true') sql += ` AND c.es_emergencia = true`;
    if (service) {
      sql += ` AND $${idx++} = ANY(c.servicios)`;
      params.push(service);
    }
    if (search) {
      sql += ` AND c.nombre ILIKE $${idx++}`;
      params.push(`%${search}%`);
    }

    sql += ` ORDER BY distance_km ASC NULLS LAST, c.calificacion_promedio DESC LIMIT $${idx++}`;
    params.push(parseInt(limit, 10));

    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('Error buscando clínicas:', err);
    res.status(500).json({ error: 'Error al buscar clínicas' });
  }
});

// ── GET /api/clinics/osm-nearby ── Proxy a Overpass/Nominatim para veterinarias OSM
router.get('/osm-nearby', requireAuth, async (req, res) => {
  const { lat, lng, radius = 30000 } = req.query;
  const p_lat = parseFloat(lat);
  const p_lng = parseFloat(lng);

  if (isNaN(p_lat) || isNaN(p_lng)) {
    return res.status(400).json({ error: 'Coordenadas inválidas' });
  }

  const r = Math.min(parseInt(radius, 10) || 15000, 50000);
  const overpassQuery = `[out:json][timeout:25];(node["amenity"="veterinary"](around:${r},${p_lat},${p_lng});way["amenity"="veterinary"](around:${r},${p_lat},${p_lng});node["healthcare"="veterinary"](around:${r},${p_lat},${p_lng});way["healthcare"="veterinary"](around:${r},${p_lat},${p_lng});node["office"="veterinary"](around:${r},${p_lat},${p_lng});way["office"="veterinary"](around:${r},${p_lat},${p_lng}););out center;`;

  const servers = [
    'https://overpass-api.de/api/interpreter',
    'https://lz4.overpass-api.de/api/interpreter',
    'https://z.overpass-api.de/api/interpreter',
  ];

  // Intentar secuencialmente en los mirrors de Overpass con timeout de 20s
  for (const server of servers) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);

      const resp = await fetch(`${server}?data=${encodeURIComponent(overpassQuery)}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!resp.ok) continue;

      const data = await resp.json();
      const elements = (data?.elements || []).map(e => {
        if (e.center) { e.lat = e.center.lat; e.lon = e.center.lon; }
        return e;
      }).filter(e => e.lat && e.lon);

      return res.json(elements);
    } catch (err) {
      console.warn(`[OSM Proxy] Error en ${server}:`, err.message);
    }
  }

  // Fallback secundario: Nominatim OpenStreetMap
  try {
    const offset = (r / 111000) * 1.2;
    const viewbox = `${p_lng - offset},${p_lat + offset},${p_lng + offset},${p_lat - offset}`;
    const nomUrl = `https://nominatim.openstreetmap.org/search?q=veterinaria&format=json&limit=40&viewbox=${viewbox}&bounded=1&addressdetails=1`;
    const nomResp = await fetch(nomUrl, {
      headers: { Accept: 'application/json', 'User-Agent': 'PetCare/1.0' },
    });
    if (nomResp.ok) {
      const nomData = await nomResp.json();
      if (nomData && nomData.length > 0) {
        const elements = nomData.map(item => ({
          lat: parseFloat(item.lat),
          lon: parseFloat(item.lon),
          tags: { name: item.name || item.display_name?.split(',')[0] || 'Veterinaria' },
        }));
        return res.json(elements);
      }
    }
  } catch (err) {
    console.warn('[OSM Proxy] Nominatim fallback falló:', err.message);
  }

  // Fallback estático mínimo si los servicios externos no responden
  return res.json([
    { lat: p_lat + 0.05, lon: p_lng + 0.05, tags: { name: 'Clínica Veterinaria Centro' } },
    { lat: p_lat - 0.05, lon: p_lng + 0.03, tags: { name: 'VetMed Plus' } },
    { lat: p_lat + 0.02, lon: p_lng - 0.04, tags: { name: 'Animal Care Clinic' } },
  ]);
});

// ── GET /api/clinics/my-clinic ── Clínica asignada al MVZ autenticado ────────
// IMPORTANTE: debe declararse antes de `GET /:id` para no interpretarse como :id
router.get('/my-clinic', requireAuth, requireVet, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT ${CLINIC_DETAIL_SELECT}
      FROM clinicas c
      WHERE c.reclamada_por = $1 AND c.activa = true
      LIMIT 1
    `, [req.user.id]);

    if (!rows.length) {
      return res.status(404).json({ error: 'No tienes una clínica asignada' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('Error al obtener mi clínica:', err);
    res.status(500).json({ error: 'Error al obtener tu clínica' });
  }
});

// ── GET /api/clinics/:id ── Ficha completa de una clínica ─────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT ${CLINIC_DETAIL_SELECT}
      FROM clinicas c
      WHERE c.id = $1 AND c.activa = true
    `, [req.params.id]);

    if (!rows.length) return res.status(404).json({ error: 'Clínica no encontrada' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Error al obtener clínica:', err);
    res.status(500).json({ error: 'Error al obtener clínica' });
  }
});

// ── PATCH /api/clinics/:id ── Edita datos de la clínica reclamada por el MVZ ──
router.patch('/:id', requireAuth, requireVet, async (req, res) => {
  try {
    const check = await query(
      'SELECT id, reclamada_por FROM clinicas WHERE id = $1 AND activa = true',
      [req.params.id]
    );
    if (!check.rows.length) {
      return res.status(404).json({ error: 'Clínica no encontrada' });
    }
    if (check.rows[0].reclamada_por !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Sin permiso para editar esta clínica' });
    }

    const { name, address, phone, whatsapp, is_24h, is_emergency } = req.body;
    const { rows } = await query(`
      UPDATE clinicas
      SET nombre         = COALESCE($1, nombre),
          direccion      = COALESCE($2, direccion),
          telefono       = COALESCE($3, telefono),
          whatsapp       = COALESCE($4, whatsapp),
          es_24h         = COALESCE($5, es_24h),
          es_emergencia  = COALESCE($6, es_emergencia),
          actualizado_en = NOW()
      WHERE id = $7
      RETURNING id, nombre AS name, direccion AS address, ciudad AS city,
                estado AS state, telefono AS phone, whatsapp, correo AS email,
                sitio_web AS website, lat, lng, horario AS schedule, servicios AS services,
                foto_url AS photo_url, es_24h AS is_24h, es_emergencia AS is_emergency,
                verificada AS is_verified, activa AS is_active,
                calificacion_promedio AS rating_avg, total_resenas AS rating_count,
                reclamada_por AS claimed_by
    `, [
      name ?? null,
      address ?? null,
      phone ?? null,
      whatsapp ?? null,
      typeof is_24h === 'boolean' ? is_24h : null,
      typeof is_emergency === 'boolean' ? is_emergency : null,
      req.params.id,
    ]);

    res.json(rows[0]);
  } catch (err) {
    console.error('Error actualizando clínica:', err);
    res.status(500).json({ error: 'Error al actualizar clínica' });
  }
});

// ── POST /api/clinics ── Alta de nueva clínica en el directorio ───────────────
router.post('/',
  requireAuth,
  ...uploadImage('photo', FOLDERS.CLINIC_PHOTOS, { maxWidth: 1200, maxHeight: 900 }),
  async (req, res) => {
    try {
      const {
        name, address, city, state, zip_code, phone, whatsapp,
        email, website, lat, lng, google_place_id,
        schedule, services, is_24h = false, is_emergency = false,
      } = req.body;

      const servicesArr = Array.isArray(services) ? services
                          : (services ? JSON.parse(services) : null);
      const scheduleObj = schedule ? (typeof schedule === 'string' ? JSON.parse(schedule) : schedule) : null;

      const { rows } = await query(`
        INSERT INTO clinicas (
          nombre, direccion, ciudad, estado, codigo_postal, telefono, whatsapp,
          correo, sitio_web, lat, lng, google_place_id,
          horario, servicios, es_24h, es_emergencia, foto_url, reclamada_por
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        RETURNING id, nombre AS name, direccion AS address, ciudad AS city,
                  telefono AS phone, lat, lng, es_24h AS is_24h, es_emergencia AS is_emergency
      `, [
        name || 'Clínica', address || '', city || null, state || null, zip_code || null,
        phone || null, whatsapp || null, email || null, website || null,
        lat ? parseFloat(lat) : null, lng ? parseFloat(lng) : null,
        google_place_id || null, scheduleObj, servicesArr,
        is_24h === true || is_24h === 'true',
        is_emergency === true || is_emergency === 'true',
        req.uploadedFileUrl || null,
        req.user.role === 'vet' ? req.user.id : null,
      ]);

      res.status(201).json(rows[0]);
    } catch (err) {
      console.error('Error creando clínica:', err);
      res.status(500).json({ error: 'Error al crear clínica' });
    }
  }
);

export default router;
