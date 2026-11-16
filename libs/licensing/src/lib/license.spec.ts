import { generateKeyPairSync } from 'node:crypto';
import {
  canIssueDocuments,
  evaluateLicense,
  LicensePayload,
  signLicense,
  verifyLicense,
} from './license';

const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
};

const keys = pair();
const now = new Date('2026-11-16T12:00:00-05:00');
const nowSec = Math.floor(now.getTime() / 1000);

const payload = (over: Partial<LicensePayload> = {}): LicensePayload => ({
  iid: 'inst-1',
  client: 'Ferretería Demo',
  plan: 'negocio',
  status: 'active',
  kind: 'periodic',
  limits: { maxTenants: 1, maxEstablishments: 1, maxEmissionPoints: 3, maxUsers: 5, maxDocumentsPerMonth: 0, modules: [] },
  iat: nowSec,
  exp: nowSec + 48 * 3600,
  ...over,
});

describe('licencia', () => {
  it('firma y verifica', () => {
    const token = signLicense(payload(), keys.priv);
    expect(token.startsWith('VKL1.')).toBe(true);
    expect(verifyLicense(token, keys.pub).iid).toBe('inst-1');
  });

  it('acepta llaves PEM en una sola línea con \\n literales', () => {
    const oneLine = (s: string) => s.trim().replace(/\n/g, '\\n');
    const token = signLicense(payload(), oneLine(keys.priv));
    expect(verifyLicense(token, oneLine(keys.pub)).plan).toBe('negocio');
  });

  it('detecta contenido alterado', () => {
    const token = signLicense(payload(), keys.priv);
    const [p, , s] = token.split('.');
    const tampered = Buffer.from(JSON.stringify(payload({ plan: 'pro' }))).toString('base64url');
    expect(evaluateLicense(`${p}.${tampered}.${s}`, keys.pub, now).state).toBe('invalid');
  });

  it('rechaza firma de otra llave', () => {
    const token = signLicense(payload(), pair().priv);
    expect(evaluateLicense(token, keys.pub, now)).toEqual({ state: 'invalid', reason: 'Firma de licencia inválida' });
  });

  it('válida dentro de las 48 h', () => {
    const state = evaluateLicense(signLicense(payload(), keys.priv), keys.pub, now);
    expect(state.state).toBe('valid');
    expect(canIssueDocuments(state)).toBe(true);
  });

  it('expira a las 48 h sin validar y bloquea emisión', () => {
    const later = new Date(now.getTime() + 48 * 3600 * 1000);
    const state = evaluateLicense(signLicense(payload(), keys.priv), keys.pub, later);
    expect(state.state).toBe('expired');
    expect(canIssueDocuments(state)).toBe(false);
  });

  it('suspendida bloquea emisión', () => {
    const state = evaluateLicense(signLicense(payload({ status: 'suspended' }), keys.priv), keys.pub, now);
    expect(state.state).toBe('suspended');
    expect(canIssueDocuments(state)).toBe(false);
  });

  it('rechaza licencia de otra instalación', () => {
    const state = evaluateLicense(signLicense(payload(), keys.priv), keys.pub, now, 'inst-2');
    expect(state.state).toBe('invalid');
  });

  it('sin token = missing', () => {
    expect(evaluateLicense(null, keys.pub, now).state).toBe('missing');
  });
});
