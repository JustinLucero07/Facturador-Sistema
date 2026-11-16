import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Cifrado AES-256-GCM para secretos guardados en BD (2FA, certificados .p12 y su clave, SMTP, APIs).
 * La llave maestra (32 bytes base64) vive solo en la variable de entorno MASTER_KEY del servidor.
 * Formato: `v1:<iv>:<tag>:<ciphertext>` (base64).
 */
function key(masterKeyB64: string): Buffer {
  const k = Buffer.from(masterKeyB64, 'base64');
  if (k.length !== 32) throw new Error('MASTER_KEY debe ser de 32 bytes en base64');
  return k;
}

export function encryptSecret(plain: string | Buffer, masterKeyB64: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(masterKeyB64), iv);
  const data = Buffer.concat([cipher.update(typeof plain === 'string' ? Buffer.from(plain, 'utf8') : plain), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decryptSecretBuffer(payload: string, masterKeyB64: string): Buffer {
  const [version, iv, tag, data] = payload.split(':');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Secreto cifrado con formato inválido');
  const decipher = createDecipheriv('aes-256-gcm', key(masterKeyB64), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]);
}

export function decryptSecret(payload: string, masterKeyB64: string): string {
  return decryptSecretBuffer(payload, masterKeyB64).toString('utf8');
}
