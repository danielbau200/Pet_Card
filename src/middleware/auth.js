/**
 * src/middleware/auth.js — Middlewares de autenticación JWT y autorización por rol
 *
 * Utiliza tokens JWT stateless firmados con `JWT_SECRET`. En cada petición protegida
 * valida el token y confirma contra la tabla `usuarios` que la cuenta siga activa.
 */
import jwt from 'jsonwebtoken';
import { query } from '../config/database.js';

/**
 * Exige un token JWT válido (header `Authorization: Bearer ...` o query `?token=...`
 * para enlaces directos de descarga como PDFs/STL). Adjunta el usuario en `req.user`.
 */
export async function requireAuth(req, res, next) {
  try {
    let token = null;
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    } else if (req.query.token) {
      token = req.query.token;
    }

    if (!token) {
      return res.status(401).json({ error: 'Token de autenticación requerido' });
    }

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      const msg = err.name === 'TokenExpiredError'
        ? 'Token expirado. Por favor inicia sesión nuevamente.'
        : 'Token inválido';
      return res.status(401).json({ error: msg });
    }

    // Confirmar que el usuario existe y continúa activo en la BD
    const { rows } = await query(
      'SELECT id, correo AS email, nombre_completo AS full_name, rol AS role, plan, plan_expira_en AS plan_expires_at, activo AS is_active FROM usuarios WHERE id = $1',
      [payload.userId]
    );

    if (!rows.length || rows[0].is_active === false) {
      return res.status(401).json({ error: 'Usuario no encontrado o inactivo' });
    }

    req.user = rows[0];
    next();
  } catch (err) {
    console.error('Error en middleware auth:', err);
    res.status(500).json({ error: 'Error interno de autenticación' });
  }
}

/**
 * Restringe el acceso únicamente a médicos veterinarios (`vet`) o administradores (`admin`).
 */
export function requireVet(req, res, next) {
  if (!['vet', 'admin'].includes(req.user?.role)) {
    return res.status(403).json({
      error: 'Acceso denegado. Se requiere perfil veterinario.',
    });
  }
  next();
}

/**
 * Firma un token JWT stateless con el identificador y rol del usuario.
 *
 * @param {string} userId - UUID del usuario en `usuarios`
 * @param {string} role - Rol del usuario (`owner` | `vet` | `admin`)
 * @returns {Promise<string>} Token JWT firmado
 */
export async function generateToken(userId, role) {
  return jwt.sign(
    { userId, role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}
