/**
 * src/routes/auth.js — Rutas de autenticación, sesión demo, perfil y cuenta
 *
 * Gestiona login tradicional (bcrypt + JWT), Google OAuth 2.0, cambio de sesión
 * demo (dueño <-> MVZ), edición de perfil con avatar, gestión de contraseña,
 * exportación de datos en PDF y eliminación completa de cuenta desde aplicación.
 */
import express from 'express';
import bcrypt from 'bcryptjs';
import passport from 'passport';
import PDFDocument from 'pdfkit';
import { query } from '../config/database.js';
import { generateToken, requireAuth } from '../middleware/auth.js';
import { uploadImage } from '../middleware/upload.js';
import { FOLDERS, deleteFile } from '../config/storage.js';
import '../config/passport.js';

const router = express.Router();

// ── GET /api/auth/google ── Inicia el flujo OAuth con Google ───────────────────
router.get('/google', (req, res, next) => {
  const role = req.query.role || 'owner';
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    session: false,
    state: role,
  })(req, res, next);
});

// ── GET /api/auth/google/callback ── Callback de Google y redirección al SPA ──
router.get('/google/callback', (req, res, next) => {
  passport.authenticate('google', { session: false }, async (err, user, info) => {
    if (err || !user) {
      console.error('❌ Error en Google OAuth callback:', err || info);
      const errMsg = err?.message || info?.message || 'Error de autenticación desconocido';
      return res.redirect(`/?auth_error=google&details=${encodeURIComponent(errMsg)}`);
    }

    try {
      const token = await generateToken(user.id, user.role);
      const frontendUrl = process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`;

      res.redirect(`${frontendUrl}/?token=${token}&user=${encodeURIComponent(JSON.stringify({
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        plan: user.plan || 'free',
        avatar_url: user.avatar_url,
        has_password: user.password_hash !== null && user.password_hash !== 'GOOGLE_OAUTH_NO_PASSWORD',
      }))}`);
    } catch (redirectErr) {
      console.error('Error en Google callback redirect:', redirectErr);
      res.redirect('/?auth_error=server');
    }
  })(req, res, next);
});

// ── POST /api/auth/register ── Alta de nueva cuenta (dueño o veterinario) ─────
router.post('/register', async (req, res) => {
  try {
    const { email, password, full_name, phone, role = 'owner' } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'El correo es requerido' });
    }

    const existing = await query('SELECT id FROM usuarios WHERE correo = $1', [email.toLowerCase()]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'Ya existe una cuenta con ese correo' });
    }

    const password_hash = password ? await bcrypt.hash(password, 10) : null;

    const { rows } = await query(`
      INSERT INTO usuarios (correo, contrasena_hash, nombre_completo, telefono, rol)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, correo AS email, nombre_completo AS full_name, rol AS role, plan, creado_en AS created_at
    `, [email.toLowerCase(), password_hash, full_name || email.split('@')[0], phone || null, role || 'owner']);

    const user = rows[0];
    const token = await generateToken(user.id, user.role);

    res.status(201).json({ user, token });
  } catch (err) {
    console.error('Error en register:', err);
    res.status(500).json({ error: 'Error al crear la cuenta' });
  }
});

// ── GET /api/auth/default-session ── Auto-login demo y cambio de rol (Dueño/MVZ)
router.get('/default-session', async (req, res) => {
  try {
    const targetEmail = req.query.role === 'vet'
      ? 'asuntosdann@gmail.com'
      : 'dnaielbautista8@gmail.com';

    const { rows } = await query(`
      SELECT id, correo AS email, nombre_completo AS full_name,
             ciudad_colonia AS city_neighborhood, telefono AS phone,
             rol AS role, plan, plan_expira_en AS plan_expires_at, avatar_url, activo AS is_active
      FROM usuarios
      WHERE correo = $1
      LIMIT 1
    `, [targetEmail]);

    if (!rows.length) {
      return res.status(404).json({ error: 'Usuario por defecto no encontrado' });
    }

    const user = rows[0];
    const token = await generateToken(user.id, user.role);
    res.json({ user, token });
  } catch (err) {
    console.error('Error en default-session:', err);
    res.status(500).json({ error: 'Error al iniciar sesión por defecto' });
  }
});

// ── POST /api/auth/login ── Inicio de sesión con correo y contraseña ──────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Correo y contraseña son requeridos' });
    }

    const { rows } = await query(`
      SELECT id, correo AS email, contrasena_hash AS password_hash, nombre_completo AS full_name,
             rol AS role, plan, plan_expira_en AS plan_expires_at, avatar_url, activo AS is_active
      FROM usuarios WHERE correo = $1
    `, [email.toLowerCase()]);

    if (!rows.length) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }

    const user = rows[0];

    if (user.is_active === false) {
      return res.status(403).json({ error: 'Cuenta desactivada.' });
    }

    if (!user.password_hash || user.password_hash === 'GOOGLE_OAUTH_NO_PASSWORD') {
      return res.status(401).json({ error: 'Esta cuenta usa Google. Inicia sesión con Google o establece una contraseña.' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }

    await query('UPDATE usuarios SET ultimo_acceso_en = NOW() WHERE id = $1', [user.id]);

    const token = await generateToken(user.id, user.role);
    delete user.password_hash;

    res.json({ user, token });
  } catch (err) {
    console.error('Error en login:', err);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

// ── GET /api/auth/me ── Devuelve el perfil completo del usuario autenticado ───
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT id, correo AS email, nombre_completo AS full_name, telefono AS phone,
             telefono_alterno AS phone_alt, ciudad_colonia AS city_neighborhood,
             veterinario_principal_nombre AS primary_vet_name,
             veterinario_principal_telefono AS primary_vet_phone,
             rol AS role, plan, plan_expira_en AS plan_expires_at,
             avatar_url, idioma AS locale, zona_horaria AS timezone,
             creado_en AS created_at, ultimo_acceso_en AS last_login_at,
             (contrasena_hash IS NOT NULL AND contrasena_hash != 'GOOGLE_OAUTH_NO_PASSWORD') AS has_password,
             (google_id IS NOT NULL) AS has_google,
             telefono_verificado AS phone_verified, tema AS theme,
             cedula_profesional AS license_number, especialidad AS specialty
      FROM usuarios WHERE id = $1
    `, [req.user.id]);

    res.json(rows[0]);
  } catch {
    res.status(500).json({ error: 'Error al obtener perfil' });
  }
});

// ── PATCH /api/auth/profile ── Actualiza perfil de dueño o MVZ y su avatar ────
router.patch('/profile',
  requireAuth,
  ...uploadImage('avatar', FOLDERS.AVATARS, { maxWidth: 400, maxHeight: 400 }),
  async (req, res) => {
    try {
      const {
        full_name, phone, locale, timezone,
        phone_alt, city_neighborhood, primary_vet_name, primary_vet_phone, theme,
        license_number, specialty,
      } = req.body;
      const updates = {};
      const values = [];
      let idx = 1;

      if (full_name !== undefined)         { updates.nombre_completo = `$${idx++}`;                values.push(full_name || null); }
      if (phone !== undefined)             { updates.telefono = `$${idx++}`;                       values.push(phone || null); }
      if (phone_alt !== undefined)         { updates.telefono_alterno = `$${idx++}`;               values.push(phone_alt || null); }
      if (city_neighborhood !== undefined) { updates.ciudad_colonia = `$${idx++}`;                 values.push(city_neighborhood || null); }
      if (primary_vet_name !== undefined)  { updates.veterinario_principal_nombre = `$${idx++}`;   values.push(primary_vet_name || null); }
      if (primary_vet_phone !== undefined) { updates.veterinario_principal_telefono = `$${idx++}`; values.push(primary_vet_phone || null); }
      if (license_number !== undefined)    { updates.cedula_profesional = `$${idx++}`;             values.push(license_number || null); }
      if (specialty !== undefined)         { updates.especialidad = `$${idx++}`;                   values.push(specialty || null); }
      if (locale)                          { updates.idioma = `$${idx++}`;                         values.push(locale); }
      if (timezone)                        { updates.zona_horaria = `$${idx++}`;                   values.push(timezone); }
      if (theme)                           { updates.tema = `$${idx++}`;                           values.push(theme); }

      if (req.uploadedFileUrl) {
        const old = await query('SELECT avatar_url FROM usuarios WHERE id = $1', [req.user.id]);
        if (old.rows[0]?.avatar_url) await deleteFile(old.rows[0].avatar_url);
        updates.avatar_url = `$${idx++}`;
        values.push(req.uploadedFileUrl);
      }

      if (!Object.keys(updates).length) {
        return res.status(400).json({ error: 'No hay campos para actualizar' });
      }

      values.push(req.user.id);
      const setClause = Object.entries(updates)
        .map(([col, placeholder]) => `${col} = ${placeholder}`)
        .join(', ');

      const { rows } = await query(`
        UPDATE usuarios SET ${setClause}, actualizado_en = NOW()
        WHERE id = $${idx}
        RETURNING id, correo AS email, nombre_completo AS full_name, telefono AS phone,
                  telefono_alterno AS phone_alt, ciudad_colonia AS city_neighborhood,
                  veterinario_principal_nombre AS primary_vet_name,
                  veterinario_principal_telefono AS primary_vet_phone,
                  rol AS role, plan, avatar_url, idioma AS locale, zona_horaria AS timezone,
                  tema AS theme, cedula_profesional AS license_number, especialidad AS specialty
      `, values);

      res.json(rows[0]);
    } catch (err) {
      console.error('Error actualizando perfil:', err);
      res.status(500).json({ error: 'Error al actualizar perfil' });
    }
  }
);

// ── POST /api/auth/change-password ── Cambia contraseña validando la actual ────
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Se requieren la contraseña actual y la nueva' });
    }

    const { rows } = await query(
      'SELECT contrasena_hash AS password_hash FROM usuarios WHERE id = $1',
      [req.user.id]
    );
    const userHash = rows[0]?.password_hash;

    if (!userHash || userHash === 'GOOGLE_OAUTH_NO_PASSWORD') {
      return res.status(400).json({ error: 'Usa /set-password para establecer una contraseña.' });
    }

    const valid = await bcrypt.compare(current_password, userHash);
    if (!valid) {
      return res.status(401).json({ error: 'Contraseña actual incorrecta' });
    }

    const new_hash = await bcrypt.hash(new_password, 10);
    await query('UPDATE usuarios SET contrasena_hash = $1 WHERE id = $2', [new_hash, req.user.id]);

    res.json({ message: 'Contraseña actualizada exitosamente' });
  } catch {
    res.status(500).json({ error: 'Error al cambiar contraseña' });
  }
});

// ── POST /api/auth/set-password ── Habilita login manual a cuentas Google ─────
router.post('/set-password', requireAuth, async (req, res) => {
  try {
    const { new_password } = req.body;
    if (!new_password) {
      return res.status(400).json({ error: 'La contraseña es requerida' });
    }

    const new_hash = await bcrypt.hash(new_password, 10);
    await query('UPDATE usuarios SET contrasena_hash = $1 WHERE id = $2', [new_hash, req.user.id]);

    res.json({ message: 'Contraseña establecida exitosamente' });
  } catch (err) {
    console.error('Error en set-password:', err);
    res.status(500).json({ error: 'Error al establecer contraseña' });
  }
});

// ── DELETE /api/auth/account ── Elimina la cuenta y sus registros asociados ──
// El borrado en cascada se hace desde la app porque las tablas no tienen FK SQL.
router.delete('/account', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    await query('DELETE FROM vacunas_mascota WHERE mascota_id IN (SELECT id FROM mascotas WHERE dueno_id = $1)', [userId]);
    await query('DELETE FROM tratamientos WHERE mascota_id IN (SELECT id FROM mascotas WHERE dueno_id = $1)', [userId]);
    await query('DELETE FROM citas WHERE dueno_id = $1', [userId]);
    await query('DELETE FROM mascotas WHERE dueno_id = $1', [userId]);
    await query('DELETE FROM usuarios WHERE id = $1', [userId]);
    res.json({ message: 'Cuenta eliminada con éxito' });
  } catch (err) {
    console.error('Error al eliminar cuenta:', err);
    res.status(500).json({ error: 'Error al eliminar cuenta.' });
  }
});

// ── POST /api/auth/google/unlink ── Desvincula Google OAuth de la cuenta ──────
router.post('/google/unlink', requireAuth, async (req, res) => {
  try {
    await query('UPDATE usuarios SET google_id = NULL WHERE id = $1', [req.user.id]);
    res.json({ message: 'Cuenta de Google desvinculada' });
  } catch {
    res.status(500).json({ error: 'Error al desvincular' });
  }
});

// ── GET /api/auth/export-data ── Exporta datos del usuario y mascotas en PDF ──
router.get('/export-data', requireAuth, async (req, res) => {
  try {
    const userRes = await query(
      'SELECT correo AS email, nombre_completo AS full_name, telefono AS phone FROM usuarios WHERE id = $1',
      [req.user.id]
    );
    const petsRes = await query(
      'SELECT nombre AS name, especie AS species, raza AS breed, fecha_nacimiento AS birthdate, alergias_conocidas AS known_allergies FROM mascotas WHERE dueno_id = $1',
      [req.user.id]
    );
    const user = userRes.rows[0];

    const doc = new PDFDocument({ margin: 50 });
    res.setHeader('Content-disposition', `attachment; filename=PetCare_Datos_${(user.full_name || 'usuario').replace(/\s+/g, '_')}.pdf`);
    res.setHeader('Content-type', 'application/pdf');
    doc.pipe(res);

    doc.fontSize(24).text('Mis Datos - PetCare Manager', { align: 'center' }).moveDown();
    doc.fontSize(14).text(`Usuario: ${user.full_name || '-'}`);
    doc.text(`Correo: ${user.email}`);
    doc.text(`Teléfono: ${user.phone || 'No registrado'}`).moveDown(2);

    doc.fontSize(18).text('Mascotas Registradas').moveDown(0.5);

    if (petsRes.rows.length === 0) {
      doc.fontSize(12).text('No hay mascotas registradas.');
    } else {
      for (const pet of petsRes.rows) {
        doc.fontSize(14).text(`${pet.name} (${pet.species || '-'})`);
        doc.fontSize(12).text(`Raza: ${pet.breed || '-'}, Nacimiento: ${pet.birthdate ? pet.birthdate.toISOString().split('T')[0] : '-'}`);
        doc.text(`Alergias: ${pet.known_allergies?.join(', ') || 'Ninguna'}`);
        doc.moveDown(0.5);
      }
    }

    doc.end();
  } catch (err) {
    console.error('Error generando PDF de datos:', err);
    res.status(500).json({ error: 'Error generando PDF' });
  }
});

export default router;
