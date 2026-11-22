/**
 * src/routes/appointments.js — Agenda de citas, solicitudes, urgencias y recetas PDF
 *
 * Flujo de estados en `citas.estado`:
 * - `pending`: solicitud creada por el dueño en espera de confirmación de la clínica/MVZ.
 * - `urgent`: emergencia inmediata reportada por el dueño (avisa al MVZ sin esperar aprobación).
 * - `scheduled`: cita confirmada por el MVZ o creada directamente desde su panel.
 * - `completed` / `rejected` / `cancelled`: estados finales.
 */
import express from 'express';
import PDFDocument from 'pdfkit';
import { query } from '../config/database.js';
import { requireAuth, requireVet } from '../middleware/auth.js';
import { uploadFile } from '../config/storage.js';

const router = express.Router();

const APPT_RETURNING = `
  id, mascota_id AS pet_id, dueno_id AS owner_id, veterinario_id AS vet_id,
  fecha_programada AS scheduled_at, duracion_min AS duration_min,
  motivo AS reason, nombre_clinica AS clinic_name, direccion_clinica AS clinic_address,
  estado AS status, diagnostico AS diagnosis, notas AS notes,
  peso_en_visita AS weight_at_visit, proxima_visita AS next_visit_date,
  receta_url AS prescription_url, recordatorio_enviado AS reminder_sent,
  creado_en AS created_at, actualizado_en AS updated_at
`;

// ── GET /api/appointments ── Lista citas del dueño, veterinario asignado o clínica reclamada
router.get('/', requireAuth, async (req, res) => {
  try {
    const { pet_id, status, from, to, limit = 50, offset = 0 } = req.query;

    let sql = `
      SELECT
        c.id, c.mascota_id AS pet_id, c.dueno_id AS owner_id, c.veterinario_id AS vet_id,
        c.clinica_id AS clinic_id,
        c.fecha_programada AS scheduled_at, c.duracion_min AS duration_min,
        c.motivo AS reason, c.nombre_clinica AS clinic_name, c.direccion_clinica AS clinic_address,
        c.estado AS status, c.diagnostico AS diagnosis, c.notas AS notes,
        c.peso_en_visita AS weight_at_visit, c.proxima_visita AS next_visit_date,
        c.receta_url AS prescription_url, c.recordatorio_enviado AS reminder_sent,
        c.creado_en AS created_at, c.actualizado_en AS updated_at,
        m.nombre AS pet_name, m.especie AS pet_species, m.foto_url AS pet_photo,
        u.nombre_completo AS vet_name,
        uo.nombre_completo AS owner_name, uo.telefono AS owner_phone
      FROM citas c
      JOIN mascotas m ON m.id = c.mascota_id
      LEFT JOIN usuarios u ON u.id = c.veterinario_id
      LEFT JOIN usuarios uo ON uo.id = c.dueno_id
      WHERE (
        c.dueno_id = $1
        OR c.veterinario_id = $1
        OR c.clinica_id IN (SELECT id FROM clinicas WHERE reclamada_por = $1)
      )
    `;
    const params = [req.user.id];
    let idx = 2;

    if (pet_id) { sql += ` AND c.mascota_id = $${idx++}`;       params.push(pet_id); }
    if (status) { sql += ` AND c.estado = $${idx++}`;           params.push(status); }
    if (from)   { sql += ` AND c.fecha_programada >= $${idx++}`; params.push(from); }
    if (to)     { sql += ` AND c.fecha_programada <= $${idx++}`; params.push(to); }

    sql += ` ORDER BY c.fecha_programada DESC NULLS LAST LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(parseInt(limit, 10), parseInt(offset, 10));

    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('Error al obtener citas:', err);
    res.status(500).json({ error: 'Error al obtener citas' });
  }
});

// ── POST /api/appointments ── Solicitud de dueño, urgencia inmediata o alta por MVZ
router.post('/', requireAuth, async (req, res) => {
  try {
    let {
      pet_id, vet_id, scheduled_at, duration_min = 30,
      reason, clinic_name, clinic_address, clinic_id, is_urgent, status,
    } = req.body;

    if (!pet_id) {
      return res.status(400).json({ error: 'Selecciona una mascota para la cita' });
    }

    const petCheck = await query(
      'SELECT id, dueno_id AS owner_id FROM mascotas WHERE id = $1 AND activo = true',
      [pet_id]
    );
    if (!petCheck.rows.length) {
      return res.status(404).json({ error: 'Mascota no encontrada' });
    }

    const realOwnerId = petCheck.rows[0].owner_id;
    if (req.user.role !== 'vet' && realOwnerId !== req.user.id) {
      return res.status(403).json({ error: 'No tienes permiso sobre esta mascota' });
    }

    // Si el cliente seleccionó una clínica del directorio, resuelve nombre, dirección y MVZ titular
    if (clinic_id) {
      const clinicRes = await query(
        'SELECT nombre, direccion, reclamada_por FROM clinicas WHERE id = $1 LIMIT 1',
        [clinic_id]
      );
      if (clinicRes.rows.length) {
        if (!clinic_name) clinic_name = clinicRes.rows[0].nombre;
        if (!clinic_address) clinic_address = clinicRes.rows[0].direccion;
        if (!vet_id && clinicRes.rows[0].reclamada_por) {
          vet_id = clinicRes.rows[0].reclamada_por;
        }
      }
    }

    // Determinar estado inicial según el rol del solicitante y si es emergencia
    let initialStatus;
    if (['vet', 'admin'].includes(req.user.role)) {
      initialStatus = 'scheduled';
    } else if (is_urgent === true || status === 'urgent' || /urgencia|emergencia/i.test(reason || '')) {
      initialStatus = 'urgent';
    } else {
      initialStatus = 'pending';
    }

    const { rows } = await query(`
      INSERT INTO citas (mascota_id, dueno_id, veterinario_id, clinica_id, fecha_programada, duracion_min,
                         motivo, nombre_clinica, direccion_clinica, estado)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING ${APPT_RETURNING}
    `, [
      pet_id,
      realOwnerId,
      vet_id || null,
      clinic_id || null,
      scheduled_at || new Date().toISOString(),
      duration_min || 30,
      reason || 'Consulta general',
      clinic_name || null,
      clinic_address || null,
      initialStatus,
    ]);

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Error creando cita:', err);
    res.status(500).json({ error: 'Error al crear cita' });
  }
});

// ── PATCH /api/appointments/:id ── Aceptar/rechazar solicitud o registrar consulta (MVZ)
router.patch('/:id', requireAuth, requireVet, async (req, res) => {
  try {
    const {
      scheduled_at, status, reason, diagnosis,
      notes, weight_at_visit, next_visit_date,
    } = req.body;

    const { rows } = await query(`
      UPDATE citas
      SET fecha_programada = COALESCE($1, fecha_programada),
          estado           = COALESCE($2, estado),
          motivo           = COALESCE($3, motivo),
          diagnostico      = COALESCE($4, diagnostico),
          notas            = COALESCE($5, notas),
          peso_en_visita   = COALESCE($6, peso_en_visita),
          proxima_visita   = COALESCE($7, proxima_visita),
          veterinario_id   = COALESCE(veterinario_id, $9),
          actualizado_en   = NOW()
      WHERE id = $8 AND (
        dueno_id = $9
        OR veterinario_id = $9
        OR clinica_id IN (SELECT id FROM clinicas WHERE reclamada_por = $9)
      )
      RETURNING ${APPT_RETURNING}
    `, [
      scheduled_at || null, status || null, reason || null, diagnosis || null,
      notes || null, weight_at_visit || null, next_visit_date || null,
      req.params.id, req.user.id,
    ]);

    if (!rows.length) return res.status(404).json({ error: 'Cita no encontrada' });
    res.json(rows[0]);
  } catch {
    res.status(500).json({ error: 'Error al actualizar cita' });
  }
});

// ── DELETE /api/appointments/:id ── Cancela cita (solo MVZ) ───────────────────
router.delete('/:id', requireAuth, requireVet, async (req, res) => {
  try {
    const { rows } = await query(
      "UPDATE citas SET estado = 'cancelled' WHERE id = $1 AND dueno_id = $2 RETURNING id",
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Cita no encontrada' });
    res.json({ message: 'Cita cancelada' });
  } catch {
    res.status(500).json({ error: 'Error al cancelar cita' });
  }
});

// ── POST /api/appointments/:id/prescription-pdf ── Genera y guarda receta PDF ──
router.post('/:id/prescription-pdf', requireAuth, async (req, res) => {
  try {
    const aptId = req.params.id;
    const sql = `
      SELECT
        c.id, c.fecha_programada AS scheduled_at, c.nombre_clinica AS clinic_name,
        c.direccion_clinica AS clinic_address, c.diagnostico AS diagnosis,
        c.notas AS notes, c.peso_en_visita AS weight_at_visit, c.proxima_visita AS next_visit_date,
        m.nombre AS pet_name, m.especie AS species, m.raza AS breed, m.peso_kg AS weight_kg,
        u.nombre_completo AS owner_name,
        v.nombre_completo AS vet_name
      FROM citas c
      JOIN mascotas m ON m.id = c.mascota_id
      JOIN usuarios u ON u.id = c.dueno_id
      LEFT JOIN usuarios v ON v.id = c.veterinario_id
      WHERE c.id = $1 AND (c.dueno_id = $2 OR c.veterinario_id = $2)
    `;
    const { rows } = await query(sql, [aptId, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Cita no encontrada o sin permisos' });

    const apt = rows[0];

    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));

    doc.fontSize(20).text('Receta Médica Veterinaria', { align: 'center' }).moveDown();

    doc.fontSize(12);
    doc.text(`Fecha: ${new Date(apt.scheduled_at).toLocaleDateString()}`);
    doc.text(`Veterinario: ${apt.vet_name || apt.clinic_name || 'Desconocido'}`);
    if (apt.clinic_address) doc.text(`Clínica: ${apt.clinic_address}`);
    doc.moveDown();

    doc.text(`Paciente: ${apt.pet_name} (${apt.species || ''} ${apt.breed || ''})`);
    doc.text(`Dueño: ${apt.owner_name}`);
    if (apt.weight_at_visit) doc.text(`Peso: ${apt.weight_at_visit} kg`);
    doc.moveDown();

    doc.fontSize(14).text('Diagnóstico', { underline: true });
    doc.fontSize(12).text(apt.diagnosis || 'No especificado').moveDown();

    doc.fontSize(14).text('Tratamiento / Indicaciones', { underline: true });
    doc.fontSize(12).text(apt.notes || 'Sin indicaciones adicionales').moveDown();

    if (apt.next_visit_date) {
      doc.text(`Próxima cita: ${new Date(apt.next_visit_date).toLocaleDateString()}`).moveDown();
    }

    doc.end();

    doc.on('end', async () => {
      try {
        const pdfBuffer = Buffer.concat(chunks);
        const filename = `receta_${apt.pet_name}_${aptId.substring(0, 8)}.pdf`;
        const pdfUrl = await uploadFile(pdfBuffer, `docs/${filename}`, 'application/pdf');

        await query('UPDATE citas SET receta_url = $1 WHERE id = $2', [pdfUrl, aptId]);
        res.json({ message: 'Receta generada', url: pdfUrl });
      } catch (uploadErr) {
        console.error('Error al subir receta PDF:', uploadErr);
        res.status(500).json({ error: 'Error al subir la receta' });
      }
    });
  } catch (err) {
    console.error('Error generando receta PDF:', err);
    res.status(500).json({ error: 'Error al generar la receta PDF' });
  }
});

// ── DELETE /api/appointments/:id/prescription-pdf ── Desvincula receta PDF ─────
router.delete('/:id/prescription-pdf', requireAuth, async (req, res) => {
  try {
    const aptId = req.params.id;
    const { rows } = await query(
      'SELECT id, receta_url AS prescription_url FROM citas WHERE id = $1 AND (dueno_id = $2 OR veterinario_id = $2)',
      [aptId, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Cita no encontrada o sin permisos' });
    if (!rows[0].prescription_url) return res.status(400).json({ error: 'No hay receta asociada a esta cita' });

    await query('UPDATE citas SET receta_url = NULL WHERE id = $1', [aptId]);
    res.json({ message: 'Receta eliminada' });
  } catch (err) {
    console.error('Error eliminando receta PDF:', err);
    res.status(500).json({ error: 'Error al eliminar la receta PDF' });
  }
});

export default router;
