/**
 * src/config/database.js — Pool de conexiones PostgreSQL y helper de consultas
 *
 * Selecciona automáticamente entre `DATABASE_URL` (entornos cloud con SSL) o
 * variables locales (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`).
 * Incluye reintentos automáticos en `query()` ante desconexiones transitorias.
 */
import pg from 'pg';
import net from 'net';
import dns from 'dns';
import dotenv from 'dotenv';

dotenv.config();

// Preferir IPv4 y desactivar autoSelectFamily para evitar timeouts dual-stack en Linux con BD cloud
dns.setDefaultResultOrder('ipv4first');
if (net.setDefaultAutoSelectFamily) {
  net.setDefaultAutoSelectFamily(false);
}

const { Pool } = pg;

const dbConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // Requerido en servicios cloud (Neon/Railway)
    }
  : {
      host:     process.env.DB_HOST     || 'localhost',
      port:     parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME     || 'petcare_db',
      user:     process.env.DB_USER     || 'petcare_user',
      password: String(process.env.DB_PASSWORD || ''),
      ssl: false,
    };

const pool = new Pool({
  ...dbConfig,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
});

pool.on('error', (err) => {
  // No terminar el proceso: los errores en conexiones inactivas pueden recuperarse en la siguiente consulta
  console.error('❌ Error inesperado en pool PostgreSQL:', err.message);
});

/**
 * Ejecuta una consulta SQL parametrizada con reintentos ante timeouts de conexión.
 *
 * @param {string} text - Sentencia SQL parametrizada ($1, $2, ...)
 * @param {Array}  [params] - Parámetros vinculados a la consulta
 * @param {object} [options] - `{ retries, delay }` para backoff exponencial simple
 */
export async function query(text, params, { retries = 3, delay = 1000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await pool.query(text, params);
    } catch (err) {
      lastErr = err;
      const isTimeout = err.message?.includes('timeout') || err.message?.includes('Connection terminated');
      if (isTimeout && attempt < retries) {
        const wait = delay * attempt;
        console.warn(`⚠️ DB timeout (intento ${attempt}/${retries}), reintentando en ${wait}ms...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      console.error('❌ Error en query:', { text: text.substring(0, 80), error: err.message });
      throw err;
    }
  }
  throw lastErr;
}

export { pool };
export default pool;
