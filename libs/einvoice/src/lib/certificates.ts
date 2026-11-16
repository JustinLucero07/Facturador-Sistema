import { Certificate, decryptSecret, decryptSecretBuffer, encryptSecret, Tx, uuidv7 } from '@vektra/db';
import type { CertificateStatus } from '@vektra/shared-contracts';
import { loadP12, SigningIdentity } from '@vektra/sri-core';
import { EInvoiceError } from './errors';

/** Umbrales de aviso de caducidad (días). */
export const CERT_ALERT_DAYS = [30, 15, 5] as const;

const identityCache = new Map<string, SigningIdentity>();

export function certificateStatus(cert: Pick<Certificate, 'holderName' | 'subject' | 'issuer' | 'validFrom' | 'validTo'> | null, now = new Date()): CertificateStatus {
  if (!cert) {
    return { present: false, holderName: null, subject: null, issuer: null, validFrom: null, validTo: null, daysLeft: null, level: 'missing', message: 'No hay firma electrónica cargada. Sin ella no se pueden emitir comprobantes.' };
  }
  const daysLeft = Math.floor((cert.validTo.getTime() - now.getTime()) / 86_400_000);
  const base = {
    present: true,
    holderName: cert.holderName,
    subject: cert.subject,
    issuer: cert.issuer,
    validFrom: cert.validFrom.toISOString(),
    validTo: cert.validTo.toISOString(),
    daysLeft,
  };
  if (daysLeft < 0) return { ...base, level: 'danger', message: 'La firma electrónica está CADUCADA. Renuévela y cárguela nuevamente para seguir facturando.' };
  if (daysLeft <= 5) return { ...base, level: 'danger', message: `La firma electrónica caduca en ${daysLeft} día(s). Renuévela de inmediato.` };
  if (daysLeft <= 30) return { ...base, level: 'warn', message: `La firma electrónica caduca en ${daysLeft} días. Solicite la renovación a su entidad certificadora.` };
  return { ...base, level: 'ok', message: 'Firma electrónica vigente' };
}

/** Valida y guarda (cifrado) un nuevo .p12. El anterior queda inactivo. */
export async function storeCertificate(tx: Tx, tenantId: string, userId: string | null, p12: Buffer, password: string, masterKey: string) {
  let identity: SigningIdentity;
  try {
    identity = loadP12(p12, password);
  } catch (e) {
    throw new EInvoiceError((e as Error).message);
  }
  if (identity.notAfter.getTime() < Date.now()) throw new EInvoiceError('El certificado ya está caducado');
  await tx.certificate.updateMany({ where: { tenantId, active: true }, data: { active: false } });
  return tx.certificate.create({
    data: {
      id: uuidv7(),
      tenantId,
      p12Enc: encryptSecret(p12, masterKey),
      passwordEnc: encryptSecret(password, masterKey),
      subject: identity.subject.slice(0, 500),
      issuer: identity.issuerName.slice(0, 500),
      serialNumber: identity.serialNumber.slice(0, 80),
      holderName: identity.holderName.slice(0, 300),
      validFrom: identity.notBefore,
      validTo: identity.notAfter,
      createdBy: userId,
    },
  });
}

export async function activeCertificate(tx: Tx): Promise<Certificate | null> {
  return tx.certificate.findFirst({ where: { active: true }, orderBy: { createdAt: 'desc' } });
}

/** Identidad de firma de la empresa actual (RLS). La clave descifrada vive solo en memoria. */
export async function loadSigningIdentity(tx: Tx, masterKey: string, now = new Date()): Promise<SigningIdentity> {
  const cert = await activeCertificate(tx);
  if (!cert) throw new EInvoiceError('Cargue la firma electrónica (.p12) de la empresa antes de emitir comprobantes');
  if (cert.validTo < now) throw new EInvoiceError('La firma electrónica está caducada. Cargue la nueva firma para seguir facturando.');
  const cached = identityCache.get(cert.id);
  if (cached) return cached;
  const identity = loadP12(decryptSecretBuffer(cert.p12Enc, masterKey), decryptSecret(cert.passwordEnc, masterKey));
  identityCache.set(cert.id, identity);
  return identity;
}
