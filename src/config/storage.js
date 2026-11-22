/**
 * src/config/storage.js — Almacenamiento de archivos multimedia (Cloudinary + fallback local)
 *
 * Sube imágenes (fotos de mascotas, avatares, documentos de vacunas) y PDFs de
 * recetas hacia Cloudinary. Si las credenciales no están configuradas, guarda los
 * archivos automáticamente en `public/uploads/`.
 */
import { v2 as cloudinary } from 'cloudinary';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.resolve(__dirname, '../../public/uploads');

let isConfigured = false;
let useLocal = false;

/**
 * Configura el SDK de Cloudinary una sola vez o activa el modo local.
 */
function initCloudinary() {
  if (isConfigured) return true;

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret || cloudName === 'tu_cloud_name') {
    console.warn('⚠️ Credenciales de Cloudinary no configuradas en .env; usando almacenamiento local.');
    useLocal = true;
    return false;
  }

  try {
    cloudinary.config({
      cloud_name: cloudName,
      api_key: apiKey,
      api_secret: apiSecret,
      secure: true,
    });
    isConfigured = true;
    return true;
  } catch (err) {
    console.error('❌ Error al inicializar Cloudinary:', err.message);
    useLocal = true;
    return false;
  }
}

export const FOLDERS = {
  PET_PHOTOS:    'petcare/pets',
  DOCUMENTS:     'petcare/docs',
  CLINIC_PHOTOS: 'petcare/clinics',
  AVATARS:       'petcare/avatars',
};

/**
 * Sube un Buffer hacia Cloudinary o a `public/uploads/` si está en modo local.
 *
 * @param {Buffer} buffer - Contenido binario del archivo
 * @param {string} destPath - Ruta lógica relativa (ej. `petcare/pets/uuid.webp`)
 * @param {string} mimeType - MIME type original
 * @param {object} [metadata] - Etiquetas opcionales para Cloudinary
 * @returns {Promise<string>} URL pública HTTPS o ruta local `/uploads/...`
 */
export async function uploadFile(buffer, destPath, mimeType, metadata = {}) {
  const ready = initCloudinary();

  if (useLocal || !ready) {
    const filename = destPath.split('/').pop();
    const folder = destPath.split('/').slice(0, -1).join('_');
    const localDir = path.join(UPLOADS_DIR, folder);

    if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });

    const localPath = path.join(localDir, filename);
    fs.writeFileSync(localPath, buffer);

    return `/uploads/${folder}/${filename}`;
  }

  const pathParts = destPath.split('/');
  const filename = pathParts.pop();
  const folder = pathParts.length > 0 ? `petcare/${pathParts.join('/')}` : 'petcare';

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        public_id: filename.split('.')[0],
        resource_type: 'auto',
        tags: ['petcare', ...(metadata.tags || [])],
      },
      (error, result) => {
        if (error) {
          console.error('❌ Error al subir archivo a Cloudinary:', error);
          reject(error);
        } else {
          resolve(result.secure_url);
        }
      }
    );

    uploadStream.end(buffer);
  });
}

/**
 * Elimina de Cloudinary una imagen previamente cargada (ignora rutas locales).
 *
 * @param {string} fileUrl - URL pública almacenada en la base de datos
 */
export async function deleteFile(fileUrl) {
  if (!fileUrl || fileUrl.startsWith('/uploads')) return;

  try {
    initCloudinary();
    // Extrae el public_id completo después del segmento /upload/<version>/
    const parts = fileUrl.split('/');
    const lastPart = parts.pop();
    const publicIdWithFolder = parts.slice(parts.indexOf('upload') + 2).join('/') + '/' + lastPart.split('.')[0];

    await cloudinary.uploader.destroy(publicIdWithFolder);
  } catch (err) {
    console.error('❌ Error eliminando archivo de Cloudinary:', err.message);
  }
}

/**
 * Verifica conectividad con Cloudinary (o confirma modo local al arranque).
 */
export async function verifyBucketConnection() {
  const ready = initCloudinary();
  if (!ready) {
    console.log('📂 Usando almacenamiento local (public/uploads)');
    return true;
  }

  try {
    await cloudinary.api.ping();
    console.log(`✅ Conectado a Cloudinary: ${process.env.CLOUDINARY_CLOUD_NAME}`);
    return true;
  } catch (err) {
    console.error('❌ Error conectando a Cloudinary:', err.message);
    return false;
  }
}

export default { uploadFile, deleteFile, verifyBucketConnection };
