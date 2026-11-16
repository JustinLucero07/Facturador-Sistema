import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

/**
 * Licencia firmada por el Vektra Hub (Ed25519) y verificada por cada instancia con la llave pública.
 * Formato: `VKL1.<payload base64url>.<firma base64url>`.
 *
 * El Hub emite tokens de vida corta (`exp` = ahora + 48 h) en cada validación periódica, así la instancia
 * sigue funcionando hasta 48 h sin contacto. Un código de activación offline es el mismo token con un
 * `exp` mayor, entregado manualmente por Vektra.
 */
export const LICENSE_PREFIX = 'VKL1';
export const DEFAULT_GRACE_HOURS = 48;

export interface PlanLimits {
  /** Empresas (RUC) en la instancia */
  maxTenants: number;
  maxEstablishments: number;
  /** Puntos de emisión / cajas */
  maxEmissionPoints: number;
  maxUsers: number;
  /** 0 = ilimitado */
  maxDocumentsPerMonth: number;
  modules: string[];
}

export interface LicensePayload {
  /** Identificador de la instalación en el Hub */
  iid: string;
  /** Nombre del cliente (para mostrar) */
  client: string;
  plan: string;
  status: 'active' | 'suspended';
  limits: PlanLimits;
  /** Tipo: periódica (validación) u offline (código de activación) */
  kind: 'periodic' | 'offline';
  /** Emitido (segundos epoch) */
  iat: number;
  /** Expira (segundos epoch) */
  exp: number;
}

export type LicenseState =
  | { state: 'valid'; payload: LicensePayload; hoursLeft: number }
  | { state: 'suspended'; payload: LicensePayload }
  | { state: 'expired'; payload: LicensePayload }
  | { state: 'invalid'; reason: string }
  | { state: 'missing' };

const b64url = (buf: Buffer) => buf.toString('base64url');

/** Las llaves PEM pueden venir en una sola línea con `\n` literales (variables de entorno). */
export function normalizePem(pem: string): string {
  return pem.replace(/\\n/g, '\n').trim();
}

export function signLicense(payload: LicensePayload, privateKeyPem: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = sign(null, body, createPrivateKey(normalizePem(privateKeyPem)));
  return `${LICENSE_PREFIX}.${b64url(body)}.${b64url(signature)}`;
}

export class LicenseVerificationError extends Error {}

/** Verifica la firma y devuelve el payload. NO revisa expiración (ver `evaluateLicense`). */
export function verifyLicense(token: string, publicKeyPem: string): LicensePayload {
  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts[0] !== LICENSE_PREFIX) {
    throw new LicenseVerificationError('Formato de licencia inválido');
  }
  const body = Buffer.from(parts[1], 'base64url');
  const signature = Buffer.from(parts[2], 'base64url');
  const ok = verify(null, body, createPublicKey(normalizePem(publicKeyPem)), signature);
  if (!ok) throw new LicenseVerificationError('Firma de licencia inválida');
  try {
    return JSON.parse(body.toString('utf8')) as LicensePayload;
  } catch {
    throw new LicenseVerificationError('Contenido de licencia ilegible');
  }
}

export function evaluateLicense(
  token: string | null | undefined,
  publicKeyPem: string,
  now: Date = new Date(),
  expectedInstallationId?: string,
): LicenseState {
  if (!token) return { state: 'missing' };
  let payload: LicensePayload;
  try {
    payload = verifyLicense(token, publicKeyPem);
  } catch (e) {
    return { state: 'invalid', reason: (e as Error).message };
  }
  if (expectedInstallationId && payload.iid !== expectedInstallationId) {
    return { state: 'invalid', reason: 'La licencia pertenece a otra instalación' };
  }
  const nowSec = Math.floor(now.getTime() / 1000);
  // Tolerancia de 5 min por desfase de reloj en el emisor.
  if (payload.iat > nowSec + 300) return { state: 'invalid', reason: 'Fecha de emisión en el futuro' };
  if (payload.status === 'suspended') return { state: 'suspended', payload };
  if (nowSec >= payload.exp) return { state: 'expired', payload };
  return { state: 'valid', payload, hoursLeft: Math.floor((payload.exp - nowSec) / 3600) };
}

/** ¿Puede la instancia emitir comprobantes? */
export function canIssueDocuments(state: LicenseState): boolean {
  return state.state === 'valid';
}
