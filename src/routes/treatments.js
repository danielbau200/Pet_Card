/**
 * src/routes/treatments.js — Tratamientos médicos recetados por mascota
 *
 * Montado bajo `/api/pets/:petId/treatments` (`mergeParams: true`).
 * El dueño puede consultar los tratamientos de sus mascotas, mientras que la
 * creación, modificación y eliminación están restringidas al perfil MVZ (`requireVet`).
 */
import express from 'express';
import { query } from '../config/database.js';
import { requireAuth, requireVet } from '../middleware/auth.js';

const router = express.Router({ mergeParams: true });

const TREAT_SELECT = `
  t.id, t.mascota_id AS pet_id, t.cita_id AS appointment_id,
  t.recetado_por AS prescribed_by, t.medicamento AS medication_name,
  t.dosis AS dose, t.frecuencia AS frequency,
  t.fecha_inicio AS start_date, t.fecha_fin AS end_date,
  t.dosis_totales AS total_doses, t.dosis_aplicadas AS doses_given,
  t.estado AS status, t.instrucciones AS instructions, t.notas AS notes,
  t.creado_en AS created_at, t.actualizado_en AS updated_at
`;

/**
 * Valida que la mascota exista y sea accesible por su dueño o por un MVZ/admin.
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

// ── GET /api/pets/:petId/treatments ── Lista tratamientos de la mascota ───────
router.get('/', requireAuth, async (req, res) => {
  try {
    const pet = await verifyPetAccess(req.params.petId, req.user.id, req.user.role);
    if (!pet) return res.status(404).json({ error: 'Mascota no encontrada' });

    const { rows } = await query(`
      SELECT ${TREAT_SELECT},
        u.nombre_completo AS prescribed_by_name
      FROM tratamientos t
      LEFT JOIN usuarios u ON u.id = t.recetado_por
      WHERE t.mascota_id = $1
      ORDER BY t.fecha_inicio DESC NULLS LAST, t.creado_en DESC
    `, [req.params.petId]);

    res.json(rows);
  } catch (err) {
    console.error('Error al obtener tratamientos:', err);
    res.status(500).json({ error: 'Error al obtener tratamientos' });
  }
});

// ── POST /api/pets/:petId/treatments ── Prescribe tratamiento nuevo (solo MVZ)
router.post('/', requireAuth, requireVet, async (req, res) => {
  try {
    const {
      medication_name, dose, frequency, start_date, end_date,
      total_doses, instructions, notes, appointment_id,
    } = req.body;

    const { rows } = await query(`
      INSERT INTO tratamientos (
        mascota_id, cita_id, recetado_por, medicamento, dosis, frecuencia,
        fecha_inicio, fecha_fin, dosis_totales, estado, instrucciones, notas
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,$11)
      RETURNING
        id, mascota_id AS pet_id, cita_id AS appointment_id, recetado_por AS prescribed_by,
        medicamento AS medication_name, dosis AS dose, frecuencia AS frequency,
        fecha_inicio AS start_date, fecha_fin AS end_date,
        dosis_totales AS total_doses, dosis_aplicadas AS doses_given,
        estado AS status, instrucciones AS instructions, notas AS notes,
        creado_en AS created_at, actualizado_en AS updated_at
    `, [
      req.params.petId,
      appointment_id || null,
      req.user.id,
      medication_name || 'Tratamiento',
      dose || null,
      frequency || null,
      start_date || new Date().toISOString().split('T')[0],
      end_date || null,
      total_doses || null,
      instructions || null,
      notes || null,
    ]);

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Error creando tratamiento:', err);
    res.status(500).json({ error: 'Error al crear tratamiento' });
  }
});

// ── PATCH /api/pets/:petId/treatments/:id ── Actualiza tratamiento (solo MVZ) ─
router.patch('/:id', requireAuth, requireVet, async (req, res) => {
  try {
    const { status, end_date, notes, instructions } = req.body;
    const { rows } = await query(`
      UPDATE tratamientos
      SET estado         = COALESCE($1, estado),
          fecha_fin      = COALESCE($2, fecha_fin),
          notas          = COALESCE($3, notas),
          instrucciones  = COALESCE($4, instrucciones),
          actualizado_en = NOW()
      WHERE id = $5 AND mascota_id = $6
      RETURNING id, mascota_id AS pet_id, medicamento AS medication_name, estado AS status
    `, [status || null, end_date || null, notes || null, instructions || null, req.params.id, req.params.petId]);

    if (!rows.length) return res.status(404).json({ error: 'Tratamiento no encontrado' });
    res.json(rows[0]);
  } catch {
    res.status(500).json({ error: 'Error al actualizar tratamiento' });
  }
});

// ── DELETE /api/pets/:petId/treatments/:id ── Elimina tratamiento (solo MVZ) ──
router.delete('/:id', requireAuth, requireVet, async (req, res) => {
  try {
    await query('DELETE FROM tratamientos WHERE id = $1 AND mascota_id = $2', [req.params.id, req.params.petId]);
    res.json({ message: 'Tratamiento eliminado' });
  } catch {
    res.status(500).json({ error: 'Error al eliminar tratamiento' });
  }
});

export default router;
