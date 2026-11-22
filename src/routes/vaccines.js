/**
 * src/routes/vaccines.js — Cartilla de vacunación y catálogo por especie
 *
 * Se monta en dos prefijos en `server.js`:
 * - `/api/pets/:petId/vaccines` (`mergeParams: true` para acceder a `:petId`)
 * - `/api/vaccines` (para consultar `/catalog/:species`)
 *
 * Lectura disponible para dueño y veterinario; escritura restringida a MVZ.
 */
import express from 'express';
import { query } from '../config/database.js';
import { requireAuth, requireVet } from '../middleware/auth.js';
import { uploadImage } from '../middleware/upload.js';
import { FOLDERS } from '../config/storage.js';

const router = express.Router({ mergeParams: true });

/**
 * Verifica que la mascota exista y pertenezca al usuario o que el rol sea MVZ/admin.
 */
async function verifyPetAccess(petId, userId, role) {
  const { rows } = await query(
    'SELECT id, dueno_id AS owner_id FROM mascotas WHERE id = $1 AND activo = true',
    [petId]
  );
  if (!rows.length) return null;
  if (rows[0].owner_id !== userId && !['vet', 'admin'].includes(role)) return null;
  return rows[0];
}

const VACCINE_SELECT = `
  vm.id,
  vm.mascota_id AS pet_id,
  vm.catalogo_id AS catalog_id,
  vm.nombre AS name,
  vm.fecha_aplicacion AS applied_date,
  vm.proxima_dosis AS next_due_date,
  vm.numero_lote AS lot_number,
  vm.fabricante AS manufacturer,
  vm.dosis_ml AS dosage_ml,
  vm.aplicada_por_vet_id AS applied_by_vet_id,
  vm.aplicada_por_nombre AS applied_by_name,
  vm.nombre_clinica AS clinic_name,
  vm.documento_url AS document_url,
  vm.estado AS status,
  vm.notas AS notes,
  vm.creado_en AS created_at,
  vm.actualizado_en AS updated_at
`;

// ── GET /api/pets/:petId/vaccines ── Historial de vacunas de la mascota ──────
router.get('/', requireAuth, async (req, res) => {
  try {
    const pet = await verifyPetAccess(req.params.petId, req.user.id, req.user.role);
    if (!pet) return res.status(404).json({ error: 'Mascota no encontrada' });

    const { rows } = await query(`
      SELECT ${VACCINE_SELECT},
        u.nombre_completo AS applied_by_vet_name
      FROM vacunas_mascota vm
      LEFT JOIN usuarios u ON u.id = vm.aplicada_por_vet_id
      WHERE vm.mascota_id = $1
      ORDER BY vm.fecha_aplicacion DESC NULLS LAST, vm.creado_en DESC
    `, [req.params.petId]);

    res.json(rows);
  } catch (err) {
    console.error('Error al obtener vacunas:', err);
    res.status(500).json({ error: 'Error al obtener vacunas' });
  }
});

// ── GET /api/vaccines/catalog/:species ── Catálogo oficial por especie ────────
router.get('/catalog/:species', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT id, especie AS species, nombre AS name, descripcion AS description,
             edad_primera_dosis_semanas AS first_dose_age_weeks,
             frecuencia_meses AS frequency_months,
             es_obligatoria AS is_required, orden AS sort_order, creado_en AS created_at
      FROM catalogo_vacunas
      WHERE especie = $1
      ORDER BY orden
    `, [req.params.species]);
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Error al obtener catálogo de vacunas' });
  }
});

// ── POST /api/pets/:petId/vaccines ── Registra vacuna aplicada (solo MVZ) ─────
router.post('/',
  requireAuth,
  requireVet,
  ...uploadImage('document', FOLDERS.DOCUMENTS, { maxWidth: 1200, maxHeight: 1600 }),
  async (req, res) => {
    try {
      const pet = await verifyPetAccess(req.params.petId, req.user.id, req.user.role);
      if (!pet) return res.status(404).json({ error: 'Mascota no encontrada' });

      const {
        catalog_id, name, applied_date, next_due_date,
        lot_number, manufacturer, dosage_ml,
        applied_by_vet_id, applied_by_name, clinic_name, notes,
      } = req.body;

      const { rows } = await query(`
        INSERT INTO vacunas_mascota (
          mascota_id, catalogo_id, nombre, fecha_aplicacion, proxima_dosis,
          numero_lote, fabricante, dosis_ml,
          aplicada_por_vet_id, aplicada_por_nombre, nombre_clinica,
          documento_url, estado, notas
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'done',$13)
        RETURNING
          id, mascota_id AS pet_id, catalogo_id AS catalog_id, nombre AS name,
          fecha_aplicacion AS applied_date, proxima_dosis AS next_due_date,
          numero_lote AS lot_number, fabricante AS manufacturer, dosis_ml AS dosage_ml,
          aplicada_por_vet_id AS applied_by_vet_id, aplicada_por_nombre AS applied_by_name,
          nombre_clinica AS clinic_name, documento_url AS document_url,
          estado AS status, notas AS notes, creado_en AS created_at, actualizado_en AS updated_at
      `, [
        req.params.petId,
        catalog_id || null,
        name || 'Vacuna',
        applied_date || null,
        next_due_date || null,
        lot_number || null,
        manufacturer || null,
        dosage_ml || null,
        applied_by_vet_id || null,
        applied_by_name || null,
        clinic_name || null,
        req.uploadedFileUrl || null,
        notes || null,
      ]);

      res.status(201).json(rows[0]);
    } catch (err) {
      console.error('Error registrando vacuna:', err);
      res.status(500).json({ error: 'Error al registrar vacuna' });
    }
  }
);

// ── PATCH /api/pets/:petId/vaccines/:id ── Actualiza refuerzo, estado o lote ──
router.patch('/:id', requireAuth, requireVet, async (req, res) => {
  try {
    const pet = await verifyPetAccess(req.params.petId, req.user.id, req.user.role);
    if (!pet) return res.status(404).json({ error: 'Mascota no encontrada' });

    const { next_due_date, status, notes, lot_number } = req.body;

    const { rows } = await query(`
      UPDATE vacunas_mascota
      SET proxima_dosis  = COALESCE($1, proxima_dosis),
          estado         = COALESCE($2, estado),
          notas          = COALESCE($3, notas),
          numero_lote    = COALESCE($4, numero_lote),
          actualizado_en = NOW()
      WHERE id = $5 AND mascota_id = $6
      RETURNING
        id, mascota_id AS pet_id, catalogo_id AS catalog_id, nombre AS name,
        fecha_aplicacion AS applied_date, proxima_dosis AS next_due_date,
        numero_lote AS lot_number, fabricante AS manufacturer, dosis_ml AS dosage_ml,
        aplicada_por_vet_id AS applied_by_vet_id, aplicada_por_nombre AS applied_by_name,
        nombre_clinica AS clinic_name, documento_url AS document_url,
        estado AS status, notas AS notes, creado_en AS created_at, actualizado_en AS updated_at
    `, [next_due_date || null, status || null, notes || null, lot_number || null, req.params.id, req.params.petId]);

    if (!rows.length) return res.status(404).json({ error: 'Registro de vacuna no encontrado' });
    res.json(rows[0]);
  } catch {
    res.status(500).json({ error: 'Error al actualizar vacuna' });
  }
});

// ── DELETE /api/pets/:petId/vaccines/:id ── Elimina vacuna (solo MVZ) ─────────
router.delete('/:id', requireAuth, requireVet, async (req, res) => {
  try {
    const pet = await verifyPetAccess(req.params.petId, req.user.id, req.user.role);
    if (!pet) return res.status(404).json({ error: 'Mascota no encontrada' });

    await query(
      'DELETE FROM vacunas_mascota WHERE id = $1 AND mascota_id = $2',
      [req.params.id, req.params.petId]
    );

    res.json({ message: 'Vacuna eliminada' });
  } catch {
    res.status(500).json({ error: 'Error al eliminar vacuna' });
  }
});

export default router;
