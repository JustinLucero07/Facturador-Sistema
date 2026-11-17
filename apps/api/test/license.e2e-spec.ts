/**
 * Licencia permanente (pago único) atada a los RUC autorizados.
 */
import type { INestApplication } from '@nestjs/common';
import { PrismaClient, ProvisionTenantResult } from '@vektra/db';
import { LicensePayload, signLicense } from '@vektra/licensing';
import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { createApp, makeTenant, ownerClient, randomRuc, seedPermissions, tokenFor, uniqueEmail } from './helpers';

describe('Licencia permanente', () => {
  let owner: PrismaClient;
  let app: INestApplication;
  let A: ProvisionTenantResult;
  let tokenA: string;
  let tokenB: string;
  const rucA = randomRuc();
  const rucB = randomRuc();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const http = () => request(app.getHttpServer());
  const code = (over: Partial<LicensePayload> = {}) =>
    signLicense(
      {
        iid: 'inst-prueba',
        client: 'Ferretería Prueba',
        plan: 'negocio',
        status: 'active',
        kind: 'perpetual',
        rucs: [rucA],
        limits: { maxTenants: 5, maxEstablishments: 5, maxEmissionPoints: 5, maxUsers: 10, maxDocumentsPerMonth: 0, modules: ['*'] },
        iat: Math.floor(Date.now() / 1000) - 60,
        exp: null,
        ...over,
      },
      priv,
    );
  const createParty = (token: string) =>
    http()
      .post('/api/parties')
      .set({ authorization: `Bearer ${token}` })
      .send({ idType: '05', identification: '1710034065', name: 'Cliente de prueba', isCustomer: true });

  beforeAll(async () => {
    owner = ownerClient();
    await seedPermissions(owner);
    await owner.instanceLicense.deleteMany({});
    const emailA = uniqueEmail('licA');
    const emailB = uniqueEmail('licB');
    A = await makeTenant(owner, rucA, emailA);
    await makeTenant(owner, rucB, emailB);
    app = await createApp({ LICENSE_PUBLIC_KEY: pub.replace(/\n/g, '\\n'), INSTALLATION_ID: 'inst-prueba' });
    tokenA = await tokenFor(app, emailA);
    tokenB = await tokenFor(app, emailB);
  });

  afterAll(async () => {
    await owner.instanceLicense.deleteMany({});
    await app.close();
    await owner.$disconnect();
  });

  it('sin licencia el sistema queda en solo lectura', async () => {
    const r = await createParty(tokenA).expect(403);
    expect(r.body.message).toMatch(/sin licencia.*solo lectura/i);
  });

  it('rechaza códigos de otra instalación o con firma falsa', async () => {
    const auth = { authorization: `Bearer ${tokenA}` };
    const other = await http().post('/api/license/activate').set(auth).send({ code: code({ iid: 'otra' }) }).expect(400);
    expect(other.body.message).toMatch(/otra instalación/);
    const forged = code().slice(0, -4) + 'AAAA';
    await http().post('/api/license/activate').set(auth).send({ code: forged }).expect(400);
  });

  it('con el código permanente funciona, no vence y solo autoriza sus RUC', async () => {
    const auth = { authorization: `Bearer ${tokenA}` };
    const st = (await http().post('/api/license/activate').set(auth).send({ code: code() }).expect(200)).body;
    expect(st).toMatchObject({ state: 'valid', kind: 'perpetual', canIssueDocuments: true, hoursLeft: null, expiresAt: null, rucs: [rucA], message: 'Licencia permanente activa' });
    await createParty(tokenA).expect(201);

    // La otra empresa (RUC no autorizado) queda en solo lectura
    const b = (await http().get('/api/license').set({ authorization: `Bearer ${tokenB}` }).expect(200)).body;
    expect(b).toMatchObject({ canIssueDocuments: false, message: expect.stringContaining(`no incluye el RUC ${rucB}`) });
    const r = await createParty(tokenB).expect(403);
    expect(r.body.message).toContain(`no incluye el RUC ${rucB}`);

    const row = await owner.instanceLicense.findUniqueOrThrow({ where: { id: 1 } });
    expect(row).toMatchObject({ installationId: 'inst-prueba', expiresAt: null });
    expect(A.tenantId).toBeTruthy();
  });

  it('un código nuevo con el RUC adicional habilita la otra empresa', async () => {
    await http().post('/api/license/activate').set({ authorization: `Bearer ${tokenA}` }).send({ code: code({ rucs: [rucA, rucB] }) }).expect(200);
    await createParty(tokenB).expect(201);
  });
});
