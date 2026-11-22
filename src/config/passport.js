/**
 * src/config/passport.js — Estrategia Google OAuth 2.0 (Passport stateless)
 *
 * Flujo de autenticación:
 * 1. Busca al usuario en `usuarios` por `google_id`.
 * 2. Si no existe con ese `google_id`, busca por `correo` y vincula la cuenta.
 * 3. Si es un usuario nuevo, lo inserta automáticamente respetando el rol (`owner`
 *    o `vet`) recibido en `req.query.state`.
 */
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { v4 as uuidv4 } from 'uuid';
import { query } from './database.js';

const CALLBACK_HOST = (process.env.PUBLIC_URL || '').trim().replace(/\/$/, '')
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 'http://localhost:3000');

const CALLBACK_URL = `${CALLBACK_HOST}/api/auth/google/callback`;
console.log(`📡 Google OAuth Callback configurado en: ${CALLBACK_URL}`);

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy(
    {
      clientID:     process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL:  CALLBACK_URL,
      proxy:        true,
      passReqToCallback: true,
    },
    async (req, accessToken, refreshToken, profile, done) => {
      try {
        const email      = profile.emails?.[0]?.value?.toLowerCase();
        const full_name  = profile.displayName || 'Usuario Google';
        const avatar_url = profile.photos?.[0]?.value || null;
        const google_id  = profile.id;

        if (!email) {
          return done(new Error('No se pudo obtener el email de Google'), null);
        }

        const USER_SELECT = `
          SELECT id, correo AS email, contrasena_hash AS password_hash, nombre_completo AS full_name,
                 avatar_url, rol AS role, plan, google_id, activo AS is_active
          FROM usuarios
        `;

        // 1. Buscar cuenta ya vinculada a Google
        let { rows } = await query(`${USER_SELECT} WHERE google_id = $1`, [google_id]);
        if (rows.length) {
          await query('UPDATE usuarios SET ultimo_acceso_en = NOW() WHERE id = $1', [rows[0].id]);
          return done(null, rows[0]);
        }

        // 2. Buscar por correo existente y vincular google_id
        ({ rows } = await query(`${USER_SELECT} WHERE correo = $1`, [email]));
        if (rows.length) {
          await query(
            'UPDATE usuarios SET google_id = $1, avatar_url = COALESCE(avatar_url, $2), ultimo_acceso_en = NOW() WHERE id = $3',
            [google_id, avatar_url, rows[0].id]
          );
          return done(null, rows[0]);
        }

        // 3. Crear usuario nuevo con el rol enviado en el parámetro state ('owner' por defecto)
        const newUserId = uuidv4();
        const role = req.query.state === 'vet' ? 'vet' : 'owner';

        ({ rows } = await query(`
          INSERT INTO usuarios (id, correo, nombre_completo, avatar_url, google_id, rol, contrasena_hash, actualizado_en)
          VALUES ($1, $2, $3, $4, $5, $6, 'GOOGLE_OAUTH_NO_PASSWORD', NOW())
          RETURNING id, correo AS email, nombre_completo AS full_name, avatar_url, rol AS role, plan, google_id
        `, [newUserId, email, full_name, avatar_url, google_id, role]));

        return done(null, rows[0]);
      } catch (err) {
        console.error('❌ Error en Google OAuth strategy:', err.message);
        return done(err, null);
      }
    }
  ));
} else {
  console.warn('⚠️ Google OAuth no configurado: faltan GOOGLE_CLIENT_ID o GOOGLE_CLIENT_SECRET');
}

export default passport;
