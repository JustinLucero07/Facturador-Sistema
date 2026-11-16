import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { getEnv } from '../config/env';

/**
 * Links públicos firmados al RIDE/XML (para WhatsApp o compartir), sin sesión:
 *   <base64url(tenantId.documentId)>.<HMAC-SHA256 truncado>
 * La llave se deriva del secreto JWT; no expira (el cliente puede volver a descargar su factura).
 */
function key(): Buffer {
  return createHash('sha256').update(`vektra-public-link:${getEnv().JWT_ACCESS_SECRET}`).digest();
}

const sign = (payload: string) => createHmac('sha256', key()).update(payload).digest('base64url').slice(0, 32);

/**
 * Llave propia de cada caja de escritorio para firmar enlaces sin conexión. Se deriva de la llave
 * del servidor, así el servidor puede verificar sin guardarla. Formato del token de caja:
 *   <base64url(tenantId.documentId.deviceId)>.<HMAC(llaveCaja, tenantId.documentId)>
 */
export function deviceLinkKey(deviceId: string): string {
  return createHmac('sha256', key()).update(`device:${deviceId}`).digest('base64url');
}

export const signWithDeviceKey = (linkKey: string, tenantId: string, documentId: string) =>
  createHmac('sha256', Buffer.from(linkKey, 'base64url')).update(`${tenantId}.${documentId}`).digest('base64url').slice(0, 32);

export function publicToken(tenantId: string, documentId: string): string {
  const payload = `${tenantId}.${documentId}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

export function verifyPublicToken(token: string): { tenantId: string; documentId: string } | null {
  const [p, sig] = token.split('.');
  if (!p || !sig) return null;
  let payload: string;
  try {
    payload = Buffer.from(p, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const [tenantId, documentId, deviceId] = payload.split('.');
  const expected = Buffer.from(deviceId ? signWithDeviceKey(deviceLinkKey(deviceId), tenantId, documentId) : sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return /^[0-9a-f-]{36}$/.test(tenantId ?? '') && /^[0-9a-f-]{36}$/.test(documentId ?? '') ? { tenantId, documentId } : null;
}

export function publicBaseUrl(): string {
  const env = getEnv();
  return (env.PUBLIC_URL || env.WEB_ORIGIN.split(',')[0]).replace(/\/$/, '');
}
