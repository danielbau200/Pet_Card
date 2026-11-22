/**
 * src/routes/pets.js — CRUD de mascotas y generación de placa QR 3D (.stl)
 *
 * La base de datos usa nombres de columnas en español (`mascotas`), por lo que
 * `PET_SELECT` y `PET_RETURNING` proyectan aliases en inglés para mantener un
 * contrato JSON consistente con el frontend.
 */
import express from 'express';
import { query } from '../config/database.js';
import { requireAuth } from '../middleware/auth.js';
import { uploadImage } from '../middleware/upload.js';
import { FOLDERS, deleteFile } from '../config/storage.js';
import { generatePlateSTL } from '../utils/stlGenerator.js';

const router = express.Router();

// Proyección estándar para SELECTs con alias m
const PET_SELECT = `
  m.id, m.dueno_id AS owner_id, m.nombre AS name, m.especie AS species,
  m.raza AS breed, m.sexo AS sex, m.fecha_nacimiento AS birthdate,
  m.peso_kg AS weight_kg, m.color, m.microchip, m.foto_url AS photo_url,
  m.esterilizado AS is_sterilized, m.activo AS is_active,
  m.alergias_conocidas AS known_allergies, m.condiciones_cronicas AS chronic_conditions,
  m.tipo_sangre AS blood_type, m.notas AS notes,
  m.veterinario_principal_id AS primary_vet_id, m.uuid_publico AS public_uuid,
  m.qr_habilitado AS qr_enabled, m.ocultar_contacto_dueno AS hide_owner_contact,
  m.caracteristicas_fisicas AS physical_characteristics, m.notas_rescatista AS notes_rescuer,
  m.creado_en AS created_at, m.actualizado_en AS updated_at
`;

// Proyección estándar para cláusulas RETURNING en INSERT/UPDATE
const PET_RETURNING = `
  id, dueno_id AS owner_id, nombre AS name, especie AS species,
  raza AS breed, sexo AS sex, fecha_nacimiento AS birthdate,
  peso_kg AS weight_kg, color, microchip, foto_url AS photo_url,
  esterilizado AS is_sterilized, activo AS is_active,
  alergias_conocidas AS known_allergies, condiciones_cronicas AS chronic_conditions,
  tipo_sangre AS blood_type, notas AS notes,
  veterinario_principal_id AS primary_vet_id, uuid_publico AS public_uuid,
  qr_habilitado AS qr_enabled, ocultar_contacto_dueno AS hide_owner_contact,
  caracteristicas_fisicas AS physical_characteristics, notas_rescatista AS notes_rescuer,
  creado_en AS created_at, actualizado_en AS updated_at
`;

// ── GET /api/pets ── Lista mascotas activas del dueño con contadores resumen ──
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT ${PET_SELECT},
        (SELECT COUNT(*) FROM vacunas_mascota vm WHERE vm.mascota_id = m.id) AS vaccine_count,
        (SELECT COUNT(*) FROM citas c WHERE c.mascota_id = m.id AND c.estado = 'scheduled') AS upcoming_appts,
        (SELECT COUNT(*) FROM tratamientos t WHERE t.mascota_id = m.id AND t.estado = 'active') AS active_treatments,
        (SELECT vm2.proxima_dosis
          FROM vacunas_mascota vm2
          WHERE vm2.mascota_id = m.id
            AND vm2.proxima_dosis IS NOT NULL
            AND vm2.estado != 'done'
          ORDER BY vm2.proxima_dosis ASC LIMIT 1
        ) AS next_vaccine_date
      FROM mascotas m
      WHERE m.dueno_id = $1 AND m.activo = true
      ORDER BY m.creado_en ASC
    `, [req.user.id]);

    res.json(rows);
  } catch (err) {
    console.error('Error listando mascotas:', err);
    res.status(500).json({ error: 'Error al obtener mascotas' });
  }
});

// ── GET /api/pets/:id ── Detalle de una mascota (dueño o cualquier MVZ/admin) ─
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT ${PET_SELECT},
        u.nombre_completo AS owner_name,
        vu.nombre_completo AS primary_vet_name,
        vu.telefono AS primary_vet_phone
      FROM mascotas m
      JOIN usuarios u ON u.id = m.dueno_id
      LEFT JOIN usuarios vu ON vu.id = m.veterinario_principal_id
      WHERE m.id = $1 AND (m.dueno_id = $2 OR $3 = 'vet' OR $3 = 'admin')
        AND m.activo = true
    `, [req.params.id, req.user.id, req.user.role]);

    if (!rows.length) {
      return res.status(404).json({ error: 'Mascota no encontrada' });
    }

    res.json(rows[0]);
  } catch {
    res.status(500).json({ error: 'Error al obtener mascota' });
  }
});

// ── POST /api/pets ── Crea una mascota nueva y genera su uuid_publico para QR ──
router.post('/',
  requireAuth,
  ...uploadImage('photo', FOLDERS.PET_PHOTOS, { maxWidth: 600, maxHeight: 600 }),
  async (req, res) => {
    try {
      const {
        name, species, breed, sex, birthdate, weight_kg, color,
        microchip, is_sterilized, known_allergies, chronic_conditions,
        blood_type, notes, primary_vet_id,
      } = req.body;

      const allergies  = Array.isArray(known_allergies) ? known_allergies
                         : (known_allergies ? [known_allergies] : null);
      const conditions = Array.isArray(chronic_conditions) ? chronic_conditions
                         : (chronic_conditions ? [chronic_conditions] : null);

      const { rows } = await query(`
        INSERT INTO mascotas (
          dueno_id, nombre, especie, raza, sexo, fecha_nacimiento, peso_kg, color,
          microchip, foto_url, esterilizado, alergias_conocidas, condiciones_cronicas,
          tipo_sangre, notas, veterinario_principal_id, caracteristicas_fisicas, notas_rescatista,
          uuid_publico, qr_habilitado
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, gen_random_uuid(), true)
        RETURNING ${PET_RETURNING}
      `, [
        req.user.id,
        name || 'Mascota',
        species || 'dog',
        breed || null,
        sex || 'unknown',
        birthdate || null,
        weight_kg || null,
        color || null,
        microchip || null,
        req.uploadedFileUrl || null,
        is_sterilized === true || is_sterilized === 'true',
        allergies,
        conditions,
        blood_type || null,
        notes || null,
        primary_vet_id || null,
        req.body.physical_characteristics || null,
        req.body.notes_rescuer || null,
      ]);

      res.status(201).json(rows[0]);
    } catch (err) {
      console.error('Error creando mascota:', err);
      res.status(500).json({ error: 'Error al registrar mascota' });
    }
  }
);

// ── PATCH /api/pets/:id ── Actualización parcial de mascota y foto ────────────
router.patch('/:id',
  requireAuth,
  ...uploadImage('photo', FOLDERS.PET_PHOTOS, { maxWidth: 600, maxHeight: 600 }),
  async (req, res) => {
    try {
      const check = await query(
        'SELECT id, dueno_id AS owner_id, foto_url AS photo_url FROM mascotas WHERE id = $1 AND activo = true',
        [req.params.id]
      );
      if (!check.rows.length) {
        return res.status(404).json({ error: 'Mascota no encontrada' });
      }
      if (check.rows[0].owner_id !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Sin permiso para editar esta mascota' });
      }

      // Mapeo explícito de campos JSON (inglés) a columnas SQL (español)
      const fieldMap = {
        name: 'nombre',
        species: 'especie',
        breed: 'raza',
        sex: 'sexo',
        birthdate: 'fecha_nacimiento',
        weight_kg: 'peso_kg',
        color: 'color',
        microchip: 'microchip',
        is_sterilized: 'esterilizado',
        known_allergies: 'alergias_conocidas',
        chronic_conditions: 'condiciones_cronicas',
        blood_type: 'tipo_sangre',
        notes: 'notas',
        primary_vet_id: 'veterinario_principal_id',
        physical_characteristics: 'caracteristicas_fisicas',
        notes_rescuer: 'notas_rescatista',
        qr_enabled: 'qr_habilitado',
      };

      const updates = [];
      const values  = [];
      let   idx     = 1;

      for (const [field, col] of Object.entries(fieldMap)) {
        if (req.body[field] !== undefined) {
          updates.push(`${col} = $${idx++}`);
          const val = req.body[field];
          if (field === 'known_allergies' || field === 'chronic_conditions') {
            values.push(Array.isArray(val) ? val : (val ? [val] : null));
          } else {
            values.push(val === '' ? null : val);
          }
        }
      }

      if (req.uploadedFileUrl) {
        if (check.rows[0].photo_url) await deleteFile(check.rows[0].photo_url);
        updates.push(`foto_url = $${idx++}`);
        values.push(req.uploadedFileUrl);
      }

      if (!updates.length) {
        return res.status(400).json({ error: 'No hay campos para actualizar' });
      }

      updates.push('actualizado_en = NOW()');
      values.push(req.params.id);
      const { rows } = await query(`
        UPDATE mascotas SET ${updates.join(', ')}
        WHERE id = $${idx}
        RETURNING ${PET_RETURNING}
      `, values);

      res.json(rows[0]);
    } catch (err) {
      console.error('Error actualizando mascota:', err);
      res.status(500).json({ error: 'Error al actualizar mascota' });
    }
  }
);

// ── DELETE /api/pets/:id ── Soft-delete (marca activo = false) ────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT dueno_id AS owner_id FROM mascotas WHERE id = $1 AND activo = true',
      [req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Mascota no encontrada' });
    }

    if (rows[0].owner_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Sin permiso' });
    }

    await query('UPDATE mascotas SET activo = false WHERE id = $1', [req.params.id]);
    res.json({ message: 'Mascota eliminada del perfil' });
  } catch {
    res.status(500).json({ error: 'Error al eliminar mascota' });
  }
});

// ── GET /api/pets/:id/plate-stl ── Descarga placa 3D STL con el QR en relieve ─
router.get('/:id/plate-stl', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT id, dueno_id AS owner_id, nombre AS name, uuid_publico AS public_uuid FROM mascotas WHERE id = $1 AND activo = true',
      [req.params.id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Mascota no encontrada' });
    }
    if (rows[0].owner_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Sin permiso' });
    }

    const pet = rows[0];
    const publicUrl = `${process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`}/emergencia/mascota/${pet.public_uuid}`;
    const stlBuffer = await generatePlateSTL(publicUrl);
    const safeName = (pet.name || 'mascota').replace(/[^a-zA-Z0-9áéíóúñÁÉÍÓÚÑ_\-\s]/g, '').trim() || 'mascota';

    res.set({
      'Content-Type': 'model/stl',
      'Content-Disposition': `attachment; filename="placa_${safeName.replace(/\s+/g, '_')}.stl"`,
      'Content-Length': stlBuffer.length,
    });
    res.send(stlBuffer);
  } catch (err) {
    console.error('Error generando placa STL:', err);
    res.status(500).json({ error: 'Error al generar placa 3D' });
  }
});

export default router;
