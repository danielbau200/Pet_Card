/**
 * src/routes/public.js — Endpoints públicos de emergencia (sin autenticación JWT)
 *
 * Se consumen cuando una persona externa escanea la placa QR física de una
 * mascota perdida en `/emergencia/mascota/:uuid`. Respeta las banderas de
 * privacidad (`qr_habilitado`, `ocultar_contacto_dueno`) configuradas por el dueño.
 */
import express from 'express';
import { query } from '../config/database.js';
import { sendEmail } from '../config/mailer.js';

const router = express.Router();

// ── GET /api/public/emergency/mascota/:uuid ── Ficha pública de emergencia QR ──
router.get('/emergency/mascota/:uuid', async (req, res) => {
  try {
    const { uuid } = req.params;

    const { rows } = await query(`
      SELECT
        m.id, m.nombre AS name, m.especie AS species, m.raza AS breed,
        m.foto_url AS photo_url, m.sexo AS sex, m.fecha_nacimiento AS birthdate,
        m.caracteristicas_fisicas AS physical_characteristics,
        m.alergias_conocidas AS known_allergies,
        m.condiciones_cronicas AS chronic_conditions,
        m.notas_rescatista AS notes_rescuer,
        m.qr_habilitado AS qr_enabled, m.activo AS is_active,
        m.ocultar_contacto_dueno AS hide_owner_contact,
        u.nombre_completo AS owner_name, u.telefono AS owner_phone,
        u.telefono_alterno AS owner_phone_alt, u.correo AS owner_email,
        u.ciudad_colonia AS owner_city,
        u.veterinario_principal_nombre AS primary_vet_name,
        u.veterinario_principal_telefono AS primary_vet_phone
      FROM mascotas m
      JOIN usuarios u ON u.id = m.dueno_id
      WHERE m.uuid_publico = $1
    `, [uuid]);

    if (!rows.length) {
      return res.status(404).json({ error: 'Mascota no encontrada' });
    }

    const pet = rows[0];

    if (pet.is_active === false || pet.qr_enabled === false) {
      return res.json({
        deactivated: true,
        message: 'Esta mascota ya no tiene un perfil de emergencia activo.',
      });
    }

    // Ocultar teléfonos y correo si el dueño activó el modo privacidad en la placa QR
    if (pet.hide_owner_contact) {
      delete pet.owner_phone;
      delete pet.owner_phone_alt;
      delete pet.owner_email;
      pet.contact_hidden = true;
    }

    const treatments = await query(`
      SELECT medicamento AS medication_name, dosis AS dose, frecuencia AS frequency
      FROM tratamientos
      WHERE mascota_id = $1 AND estado = 'active'
    `, [pet.id]);

    pet.active_treatments = treatments.rows;

    res.json(pet);
  } catch (err) {
    console.error('Error en endpoint público de emergencia:', err);
    res.status(500).json({ error: 'Error al obtener información de emergencia' });
  }
});

// ── POST /api/public/emergency/mascota/:uuid/contact ── Envía aviso por email al dueño
router.post('/emergency/mascota/:uuid/contact', async (req, res) => {
  try {
    const { uuid } = req.params;
    const { sender_name, sender_phone, message } = req.body;

    const { rows } = await query(`
      SELECT m.nombre AS name, u.correo AS owner_email, u.nombre_completo AS owner_name
      FROM mascotas m
      JOIN usuarios u ON u.id = m.dueno_id
      WHERE m.uuid_publico = $1
    `, [uuid]);

    if (!rows.length) return res.status(404).json({ error: 'Mascota no encontrada' });
    const { name: petName, owner_email, owner_name } = rows[0];

    if (owner_email) {
      sendEmail(
        owner_email,
        `¡Alguien encontró a ${petName}!`,
        `<h2>Han escaneado el QR de tu mascota de emergencia</h2>
         <p>Hola ${owner_name || ''}, alguien llamado <strong>${sender_name || 'Anónimo'}</strong> ha dejado un mensaje sobre <strong>${petName}</strong>:</p>
         <blockquote style="border-left: 4px solid #FDC33F; padding-left: 10px;">${message || ''}</blockquote>
         <p>Contacto de la persona: ${sender_phone || 'No proporcionó teléfono.'}</p>`
      ).catch(e => console.warn('No se pudo enviar email QR:', e.message));
    }

    res.json({ message: 'Mensaje enviado exitosamente al dueño' });
  } catch (err) {
    console.error('Error enviando contacto QR:', err);
    res.status(500).json({ error: 'No se pudo enviar el mensaje' });
  }
});

export default router;
