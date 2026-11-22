/**
 * src/config/mailer.js — Servicio de envío de correos electrónicos con Nodemailer
 *
 * Inicializa el transporte SMTP bajo demanda. Si no existen credenciales
 * `SMTP_HOST`, `SMTP_USER` y `SMTP_PASS`, imprime los correos en consola como
 * modo simulado para no bloquear desarrollo ni avisos del QR público.
 */
import nodemailer from 'nodemailer';

let transporter = null;

/**
 * Crea o reutiliza el transporter SMTP configurado en variables de entorno.
 */
function getTransporter() {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    console.warn('⚠️ SMTP no configurado. Los correos se imprimirán en consola.');
    return null;
  }

  transporter = nodemailer.createTransport({
    host,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_PORT === '465',
    auth: { user, pass },
  });

  return transporter;
}

/**
 * Envía un correo HTML o lo registra en consola si SMTP no está configurado.
 *
 * @param {string} to - Correo destinatario
 * @param {string} subject - Asunto del mensaje
 * @param {string} html - Cuerpo HTML
 * @returns {Promise<boolean>} `true` si se envió (o simuló), `false` si falló
 */
export async function sendEmail(to, subject, html) {
  const t = getTransporter();

  if (!t) {
    console.log(`📧 [SIMULADO] Para: ${to}\nAsunto: ${subject}\n${html.replace(/<[^>]+>/g, '')}`);
    return true;
  }

  try {
    await t.sendMail({
      from: `"PetCare" <${process.env.SMTP_USER}>`,
      to,
      subject,
      html,
    });
    return true;
  } catch (err) {
    console.error('Error enviando correo:', err.message);
    return false;
  }
}
