/**
 * Flujo completo de facturación electrónica contra un SRI simulado:
 * emitir (API) → firmar → recepción → autorización → XML autorizado → RIDE → correo.
 */
import type { INestApplication } from '@nestjs/common';
import { PrismaClient, ProvisionTenantResult, seedSriConfig, withContext } from '@vektra/db';
import { authorizeStep, emailDocument, invalidateSriSettings, RetryLaterError, sendStep } from '@vektra/einvoice';
import { isValidAccessKey, parseInvoiceXml } from '@vektra/sri-core';
import request from 'supertest';
import { createTestP12 } from '@vektra/sri-core/testing';
import { FakeSri } from './fake-sri';
import { appClient, createApp, makeTenant, ownerClient, randomRuc, seedPermissions, tokenFor, uniqueEmail } from './helpers';

describe('Facturación electrónica (flujo completo)', () => {
  let owner: PrismaClient;
  let db: PrismaClient;
  let app: INestApplication;
  let T: ProvisionTenantResult;
  let token: string;
  let rate15: string;
  let rate0: string;
  const sri = new FakeSri();
  const sentMails: { to: string; subject: string; attachments: { filename: string }[] }[] = [];
  const fakeTransport = () => ({ sendMail: async (m: { to: string; subject: string; attachments: { filename: string }[] }) => void sentMails.push(m) }) as never;

  const http = () => request(app.getHttpServer());
  const auth = () => ({ authorization: `Bearer ${token}` });
  const invoice = (over: Record<string, unknown> = {}) => ({
    emissionPointId: T.emissionPointId,
    buyer: { idType: '05', id: '1710034065', name: 'PRUEBAS SERVICIO DE RENTAS INTERNAS', email: 'cliente@example.com', address: 'Cuenca' },
    lines: [
      { mainCode: 'MART-01', description: 'Martillo 16 oz', quantity: 2, unitPrice: '10.00', taxRateId: rate15 },
      { mainCode: 'PAN', description: 'Pan', quantity: 1, unitPrice: '0.50', taxRateId: rate0 },
    ],
    payments: [{ sriCode: '01', method: 'efectivo', amount: '23.50' }],
    ...over,
  });

  beforeAll(async () => {
    owner = ownerClient();
    db = appClient();
    await seedPermissions(owner);
    await seedSriConfig(owner);
    await sri.start();
    await owner.sriSetting.update({ where: { key: 'ws.test' }, data: { value: { reception: sri.receptionUrl, authorization: sri.authorizationUrl } } });
    await owner.sriSetting.update({ where: { key: 'authorization.wait_seconds' }, data: { value: 0 } });
    invalidateSriSettings();
    rate15 = (await owner.taxRate.findFirstOrThrow({ where: { taxCode: '2', percentageCode: '4' } })).id;
    rate0 = (await owner.taxRate.findFirstOrThrow({ where: { taxCode: '2', percentageCode: '0' } })).id;
    const email = uniqueEmail('facturador');
    T = await makeTenant(owner, randomRuc(), email, 'hardware');
    app = await createApp({ REDIS_URL: 'redis://127.0.0.1:6390/5' });
    token = await tokenFor(app, email);
  });

  afterAll(async () => {
    await app.close();
    await sri.stop();
    await db.$disconnect();
    await owner.$disconnect();
  });

  it('sin firma electrónica no se puede emitir y el secuencial no se consume', async () => {
    const res = await http().post('/api/einvoice/invoices').set(auth()).send(invoice()).expect(422);
    expect(res.body.message).toMatch(/firma electrónica/);
    const counters = await owner.sequenceCounter.findMany({ where: { emissionPointId: T.emissionPointId } });
    expect(counters).toHaveLength(0);
  });

  it('carga la firma .p12 (contraseña incorrecta → error claro)', async () => {
    const p12 = createTestP12('clave123');
    const bad = await http().post('/api/einvoice/certificate').set(auth()).attach('file', p12, 'firma.p12').field('password', 'mala').expect(422);
    expect(bad.body.message).toMatch(/contraseña/);
    const ok = await http().post('/api/einvoice/certificate').set(auth()).attach('file', p12, 'firma.p12').field('password', 'clave123').expect(200);
    expect(ok.body).toMatchObject({ present: true, level: 'ok', holderName: 'JUAN PEREZ PRUEBAS' });
    // La clave y el .p12 quedan cifrados
    const stored = await owner.certificate.findFirstOrThrow({ where: { tenantId: T.tenantId, active: true } });
    expect(stored.p12Enc.startsWith('v1:')).toBe(true);
    expect(stored.passwordEnc).not.toContain('clave123');
  });

  let documentId: string;

  it('emite la factura: calcula, firma y queda FIRMADA con secuencial 1', async () => {
    const res = await http().post('/api/einvoice/invoices').set(auth()).send(invoice()).expect(201);
    expect(res.body).toMatchObject({ number: '001-001-000000001', total: '23.50' });
    expect(isValidAccessKey(res.body.accessKey)).toBe(true);
    documentId = res.body.documentId;
    const detail = await http().get(`/api/einvoice/documents/${documentId}`).set(auth()).expect(200);
    expect(detail.body.status).toBe('SIGNED');
    expect(detail.body.taxSummary).toEqual([
      { label: '0%', base: '0.50', amount: '0.00' },
      { label: '15%', base: '20.00', amount: '3.00' },
    ]);
  });

  it('el worker la envía: RECIBIDA → AUTORIZADA, con firma verificada por el SRI simulado', async () => {
    expect(await sendStep({ prisma: db }, T.tenantId, documentId)).toEqual({ kind: 'authorize', delayMs: 0 });
    expect(sri.lastSignatureValid).toBe(true);
    expect(await authorizeStep({ prisma: db }, T.tenantId, documentId)).toEqual({ kind: 'email' });
    const detail = await http().get(`/api/einvoice/documents/${documentId}`).set(auth()).expect(200);
    expect(detail.body.status).toBe('AUTHORIZED');
    expect(detail.body.authorizationNumber).toBe(detail.body.accessKey);
    expect(detail.body.events.map((e: { to: string }) => e.to)).toEqual(['SIGNED', 'RECEIVED', 'AUTHORIZED']);
    expect(detail.body.messages[0]).toMatchObject({ identifier: '60', title: 'Ambiente de pruebas', isError: false });
  });

  it('descarga el XML autorizado y el RIDE', async () => {
    const xml = await http().get(`/api/einvoice/documents/${documentId}/xml`).set(auth()).expect(200);
    expect(xml.headers['content-type']).toContain('application/xml');
    const body = xml.body instanceof Buffer ? xml.body.toString('utf8') : xml.text;
    expect(body).toContain('<estado>AUTORIZADO</estado>');
    expect(parseInvoiceXml(body).totals.total).toBe('23.50');
    const ride = await http().get(`/api/einvoice/documents/${documentId}/ride`).set(auth()).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect((ride.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('envía XML + RIDE por correo (SMTP de la empresa)', async () => {
    // Sin SMTP configurado → se omite
    expect(await emailDocument(db, T.tenantId, documentId, { masterKey: process.env['MASTER_KEY']!, transportFactory: fakeTransport })).toBe('SKIPPED');
    await http()
      .put('/api/einvoice/mail-config')
      .set(auth())
      .send({ host: 'smtp.example.com', port: 587, secure: false, username: 'u', password: 'p', fromName: 'Ferretería', fromEmail: 'facturas@example.com', enabled: true })
      .expect(204);
    expect(await emailDocument(db, T.tenantId, documentId, { masterKey: process.env['MASTER_KEY']!, transportFactory: fakeTransport })).toBe('SENT');
    const mail = sentMails.at(-1)!;
    expect(mail.to).toBe('cliente@example.com');
    expect(mail.subject).toContain('001-001-000000001');
    expect(mail.attachments.map((a) => a.filename)).toEqual([expect.stringMatching(/^\d{49}\.xml$/), 'RIDE-001-001-000000001.pdf']);
  });

  it('consumidor final: máximo $50 (parámetro en BD)', async () => {
    const cf = { idType: '07', id: '9999999999999', name: 'x' };
    const big = invoice({ buyer: cf, lines: [{ description: 'Taladro', quantity: 1, unitPrice: '60.00', taxRateId: rate15 }], payments: [{ sriCode: '01', method: 'efectivo', amount: '69.00' }] });
    const res = await http().post('/api/einvoice/invoices').set(auth()).send(big).expect(422);
    expect(res.body.message).toMatch(/consumidor final no pueden superar \$50/);
    const small = invoice({ buyer: cf, lines: [{ description: 'Clavos', quantity: 1, unitPrice: '2.00', taxRateId: rate15 }], payments: [{ sriCode: '01', method: 'efectivo', amount: '2.30' }] });
    const ok = await http().post('/api/einvoice/invoices').set(auth()).send(small).expect(201);
    expect(ok.body.number).toBe('001-001-000000002'); // el intento rechazado no consumió número
  });

  it('cambiar una tarifa desde configuración se refleja en nuevas ventas sin tocar código', async () => {
    await owner.taxRate.update({ where: { id: rate15 }, data: { rate: '16' } });
    const res = await http()
      .post('/api/einvoice/invoices')
      .set(auth())
      .send(invoice({ lines: [{ description: 'Pala', quantity: 1, unitPrice: '100.00', taxRateId: rate15 }], payments: [{ sriCode: '01', method: 'efectivo', amount: '116.00' }] }))
      .expect(201);
    expect(res.body.total).toBe('116.00');
    // La factura anterior conserva su IVA congelado
    const first = await http().get(`/api/einvoice/documents/${documentId}`).set(auth()).expect(200);
    expect(first.body.total).toBe('23.50');
    await owner.taxRate.update({ where: { id: rate15 }, data: { rate: '15' } });
  });

  it('SRI caído → EN CONTINGENCIA y se reintenta; al volver, se autoriza', async () => {
    const res = await http().post('/api/einvoice/invoices').set(auth()).send(invoice()).expect(201);
    sri.receptionMode = 'down';
    await expect(sendStep({ prisma: db }, T.tenantId, res.body.documentId)).rejects.toBeInstanceOf(RetryLaterError);
    let st = await withContext(db, { tenantId: T.tenantId }, (tx) => tx.electronicDocument.findUniqueOrThrow({ where: { documentId: res.body.documentId } }));
    expect(st.status).toBe('CONTINGENCY');
    sri.receptionMode = 'ok';
    sri.authorizationMode = 'processing';
    await sendStep({ prisma: db }, T.tenantId, res.body.documentId);
    await expect(authorizeStep({ prisma: db }, T.tenantId, res.body.documentId)).rejects.toBeInstanceOf(RetryLaterError);
    sri.authorizationMode = 'authorized';
    await authorizeStep({ prisma: db }, T.tenantId, res.body.documentId);
    st = await withContext(db, { tenantId: T.tenantId }, (tx) => tx.electronicDocument.findUniqueOrThrow({ where: { documentId: res.body.documentId } }));
    expect(st.status).toBe('AUTHORIZED');
    expect(st.attempts).toBe(2);
  });

  it('NO AUTORIZADO muestra el motivo legible y permite reenviar con la misma clave', async () => {
    const res = await http().post('/api/einvoice/invoices').set(auth()).send(invoice()).expect(201);
    sri.authorizationMode = 'rejected';
    await sendStep({ prisma: db }, T.tenantId, res.body.documentId);
    await authorizeStep({ prisma: db }, T.tenantId, res.body.documentId);
    const detail = await http().get(`/api/einvoice/documents/${res.body.documentId}`).set(auth()).expect(200);
    expect(detail.body.status).toBe('NOT_AUTHORIZED');
    expect(detail.body.messages[0]).toMatchObject({ identifier: '52', title: 'Error en diferencias', isError: true });
    sri.authorizationMode = 'authorized';
    const retry = await http().post(`/api/einvoice/documents/${res.body.documentId}/retry`).set(auth()).expect(200);
    expect(retry.body.queued).toBe('send');
    const after = await http().get(`/api/einvoice/documents/${res.body.documentId}`).set(auth()).expect(200);
    expect(after.body.status).toBe('SIGNED');
    expect(after.body.accessKey).toBe(detail.body.accessKey);
  });

  it('lista y busca comprobantes; otra empresa no los ve', async () => {
    const list = await http().get('/api/einvoice/documents?search=PRUEBAS').set(auth()).expect(200);
    expect(list.body.total).toBeGreaterThanOrEqual(4);
    const otherEmail = uniqueEmail('otra');
    await makeTenant(owner, randomRuc(), otherEmail);
    const otherToken = await tokenFor(app, otherEmail);
    const other = await http().get('/api/einvoice/documents').set({ authorization: `Bearer ${otherToken}` }).expect(200);
    expect(other.body.total).toBe(0);
    await http().get(`/api/einvoice/documents/${documentId}`).set({ authorization: `Bearer ${otherToken}` }).expect(404);
  });

  it('valida la cédula del cliente', async () => {
    const res = await http().post('/api/einvoice/invoices').set(auth()).send(invoice({ buyer: { idType: '05', id: '1710034066', name: 'X' } })).expect(422);
    expect(res.body.message).toMatch(/Cédula del cliente inválida/);
  });
});
