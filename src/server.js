/**
 * src/server.js — Punto de entrada del servidor HTTP Express (ejecución local)
 *
 * Configura CORS, limitadores de peticiones, sirve las rutas REST bajo `/api/*`,
 * expone directamente el frontend SPA (`frontend/index.html` y assets estáticos)
 * y verifica la conexión con PostgreSQL y Cloudinary al arrancar.
 */
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import passport from 'passport';

import pool from './config/database.js';
import { verifyBucketConnection } from './config/storage.js';
import './config/passport.js'; // Registra estrategia Google OAuth 2.0

import authRoutes from './routes/auth.js';
import petRoutes from './routes/pets.js';
import vaccineRoutes from './routes/vaccines.js';
import appointmentRoutes from './routes/appointments.js';
import treatmentRoutes from './routes/treatments.js';
import clinicRoutes from './routes/clinics.js';
import triageRoutes from './routes/triage.js';
import publicRoutes from './routes/public.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);
const isDev = process.env.NODE_ENV !== 'production';

const app = express();
app.set('trust proxy', 1); // Confiar en proxy inverso (Railway/Traefik) para IP y HTTPS real
app.use(passport.initialize()); // Autenticación stateless con JWT (sin sesiones Express)

// Bitácora ligera de peticiones solo en entorno de desarrollo
if (isDev) {
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });
}

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, cb) => {
    if (isDev || !origin) return cb(null, true);
    const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);

    if (process.env.PUBLIC_URL) {
      const pub = process.env.PUBLIC_URL.trim();
      allowed.push(pub, pub.replace(/\/$/, ''));
    }

    if (allowed.includes(origin)) return cb(null, true);

    console.warn('Origen bloqueado por CORS:', origin);
    cb(new Error('No permitido por CORS'));
  },
  credentials: true,
}));

// ─── RATE LIMITING ────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
  max: parseInt(process.env.RATE_LIMIT_MAX || '200', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Intenta de nuevo más tarde.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // Ventana de 15 minutos
  max: isDev ? 100 : 20,    // Más estricto en producción para evitar fuerza bruta
  message: { error: 'Demasiados intentos de autenticación. Espera 15 minutos.' },
});

app.use(globalLimiter);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ─── ARCHIVOS ESTÁTICOS ───────────────────────────────────────────────────────
// Sirve archivos subidos localmente (/uploads) y assets estáticos de frontend/ (logo.png)
app.use('/uploads', express.static(path.join(__dirname, '..', 'public', 'uploads')));
app.use(express.static(path.join(__dirname, '..', 'frontend'), { index: false }));

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'ok',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      services: {
        database: 'connected',
        storage: 'cloudinary',
        status: 'ready',
      },
    });
  } catch {
    res.status(503).json({ status: 'error', database: 'disconnected' });
  }
});

// ─── RUTAS DE LA API ──────────────────────────────────────────────────────────
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/pets', petRoutes);
app.use('/api/pets/:petId/vaccines', vaccineRoutes);
app.use('/api/pets/:petId/treatments', treatmentRoutes);
app.use('/api/vaccines', vaccineRoutes); // Expone /catalog/:species sin requerir :petId
app.use('/api/appointments', appointmentRoutes);
app.use('/api/clinics', clinicRoutes);
app.use('/api/triage', triageRoutes);
app.use('/api/public', publicRoutes);

// ─── SPA FALLBACK ─────────────────────────────────────────────────────────────
// Cualquier ruta no-API sirve directamente frontend/index.html sin caché
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
  } else {
    res.status(404).json({ error: 'Endpoint no encontrado' });
  }
});

// ─── MANEJADOR GLOBAL DE ERRORES ──────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'El archivo excede el tamaño máximo permitido (10 MB)' });
  }

  console.error(`[${new Date().toISOString()}] ERROR:`, err.message);

  res.status(err.status || 500).json({
    error: err.message || 'Error interno del servidor',
    ...(isDev ? { stack: err.stack } : {}),
  });
});

// ─── ARRANQUE DEL SERVIDOR ────────────────────────────────────────────────────
async function startServer() {
  console.log('\n PetCare Manager — Iniciando servidor...\n');

  app.listen(PORT, '0.0.0.0', () => {
    console.log(` Servidor escuchando en http://0.0.0.0:${PORT}`);
    console.log(` API base: http://0.0.0.0:${PORT}/api`);
    console.log(` Modo: ${process.env.NODE_ENV || 'development'}\n`);
  });

  // Verificar conexión inicial a PostgreSQL
  try {
    const client = await pool.connect();
    await client.query('SELECT NOW()');
    client.release();
    console.log('✅ PostgreSQL conectado');
  } catch (err) {
    console.warn('⚠️ Aviso inicial de PostgreSQL:', err.message);
  }

  // Verificar Cloudinary en segundo plano sin bloquear el arranque HTTP
  verifyBucketConnection().then(storageOk => {
    if (!storageOk) {
      console.warn('Cloudinary no disponible. Usando almacenamiento local.');
    }
  }).catch(() => {});
}

startServer();

export default app;
