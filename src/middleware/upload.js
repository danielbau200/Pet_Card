/**
 * src/middleware/upload.js — Pipeline de carga y optimización de imágenes
 *
 * Lee archivos enviados por multipart/form-data en memoria (Multer, máx. 10 MB),
 * los auto-rota por EXIF, redimensiona y convierte a WebP con Sharp, y los sube
 * a Cloudinary (o almacenamiento local fallback) dejando la URL en `req.uploadedFileUrl`.
 */
import multer from 'multer';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import { uploadFile, FOLDERS } from '../config/storage.js';

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const multerMemory = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // Límite máximo de 10 MB por imagen
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      return cb(new Error('Tipo de archivo no permitido. Solo se aceptan imágenes (JPEG, PNG, WebP, GIF).'));
    }
    cb(null, true);
  },
});

/**
 * Devuelve un par de middlewares Express para recibir, optimizar y subir una imagen.
 * Si el cliente no envía archivo en `fieldName`, continúa sin error (campo opcional).
 *
 * @param {string} fieldName - Nombre del campo multipart del formulario
 * @param {string} [folder]  - Carpeta destino definida en `FOLDERS`
 * @param {object} [options] - `{ maxWidth, maxHeight, quality }`
 */
export function uploadImage(fieldName, folder = FOLDERS.PET_PHOTOS, options = {}) {
  const {
    maxWidth  = 800,
    maxHeight = 800,
    quality   = 85,
  } = options;

  return [
    multerMemory.single(fieldName),
    async (req, res, next) => {
      try {
        if (!req.file) return next();

        const filename = `${uuidv4()}.webp`;
        const destPath = `${folder}/${filename}`;

        // Corrige orientación EXIF, escala proporcionalmente sin ampliar de más y comprime a WebP
        const processedBuffer = await sharp(req.file.buffer)
          .rotate()
          .resize(maxWidth, maxHeight, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality })
          .toBuffer();

        req.uploadedFileUrl = await uploadFile(
          processedBuffer,
          destPath,
          'image/webp',
          {
            originalName: req.file.originalname,
            uploadedBy:   req.user?.id || 'anonymous',
          }
        );

        next();
      } catch (err) {
        next(err);
      }
    },
  ];
}
