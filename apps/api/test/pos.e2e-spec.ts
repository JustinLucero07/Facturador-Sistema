/**
 * Fase 3: caja (apertura, ventas, movimientos, arqueo y cierre), ticket, proformas, link público,
 * permisos de descuento y mapeo de medios de pago → código SRI.
 */
import type { INestApplication } from '@nestjs/common';
import { PrismaClient, ProvisionTenantResult, seedSriConfig } from '@vektra/db';
import { invalidateSriSettings } from '@vektra/einvoice';
import { createTestP12 } from '@vektra/sri-core/testing';
import request from 'supertest';
import { createApp, makeTenant, ownerClient, randomRuc, seedPermissions, tokenFor, uniqueEmail } from './helpers';

describe('Punto de venta y caja', () => {
  let owner: PrismaClient;
  let app: INestApplication;
  let T: ProvisionTenantResult;
  let token: string;
  let product: { id: string; taxRateId: string };
  let sessionId: string;
  const http = () => request(app.getHttpServer());
  const auth = (t = token) => ({ authorization: `Bearer ${t}` });

  const sale = (payments: object[], over: Record<string, unknown> = {}) => ({
    emissionPointId: T.emissionPointId,
    cashSessionId: sessionId,
    buyer: { idType: '07', id: '9999999999999', name: 'CONSUMIDOR FINAL' },
    lines: [{ productId: product.id, description: 'Martillo', quantity: '1', unitPrice: '10', taxRateId: product.taxRateId }],
    payments,
    ...over,
  });

  beforeAll(async () => {
    owner = ownerClient();
    await seedPermissions(owner);
    await seedSriConfig(owner);
    await owner.sriSetting.update({ where: { key: 'ws.test' }, data: { value: { reception: 'http://127.0.0.1:1/R', authorization: 'http://127.0.0.1:1/A' } } });
    invalidateSriSettings();
    const email = uniqueEmail('cajero-admin');
    T = await makeTenant(owner, randomRuc(), email, 'hardware');
    app = await createApp();
    token = await tokenFor(app, email);
    await http().post('/api/einvoice/certificate').set(auth()).attach('file', createTestP12('k123'), 'f.p12').field('password', 'k123').expect(200);
    const lk = (await http().get('/api/catalog/lookups').set(auth())).body;
    const iva15 = lk.taxRates.find((r: { percentageCode: string }) => r.percentageCode === '4').id;
    const und = lk.units.find((u: { code: string }) => u.code === 'UND').id;
    const pub = lk.priceLists.find((l: { code: string }) => l.code === 'PUBLICO').id;
    const created = await http()
      .post('/api/products')
      .set(auth())
      .send({ code: 'MART', name: 'Martillo', unitId: und, taxRateId: iva15, barcodes: ['111'], prices: [{ priceListId: pub, unitId: und, price: '10' }] })
      .expect(201);
    product = { id: created.body.id, taxRateId: iva15 };
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  it('no se puede vender en el POS sin caja abierta', async () => {
    sessionId = '01a1e52b-0000-7000-8000-000000000000';
    const res = await http().post('/api/einvoice/invoices').set(auth()).send(sale([{ sriCode: '01', method: 'efectivo', amount: '11.50' }])).expect(422);
    expect(res.body.message).toMatch(/caja está cerrada/);
  });

  it('abre la caja; no permite dos cajas abiertas en el mismo punto de emisión', async () => {
    const res = await http().post('/api/cash/sessions').set(auth()).send({ emissionPointId: T.emissionPointId, openingAmount: '20' }).expect(201);
    sessionId = res.body.id;
    expect(res.body).toMatchObject({ status: 'OPEN', openingAmount: '20.00', cash: { expected: '20.00' } });
    await http().post('/api/cash/sessions').set(auth()).send({ emissionPointId: T.emissionPointId, openingAmount: '0' }).expect(409);
    const current = await http().get('/api/cash/current').query({ emissionPointId: T.emissionPointId }).set(auth()).expect(200);
    expect(current.body.id).toBe(sessionId);
  });

  let cashDocId: string;

  it('venta en efectivo con vuelto en el ticket; el código SRI lo decide el servidor', async () => {
    const res = await http()
      .post('/api/einvoice/invoices')
      .set(auth())
      .send(sale([{ sriCode: '99', method: 'efectivo', amount: '11.50', cashReceived: '20' }]))
      .expect(201);
    cashDocId = res.body.documentId;
    const ticket = await http().get(`/api/pos/tickets/${cashDocId}`).set(auth()).expect(200);
    expect(ticket.body).toMatchObject({ total: '11.50', number: '001-001-000000001', payments: [{ label: 'Efectivo', amount: '11.50', cashReceived: '20.00', change: '8.50' }] });
    const pay = await owner.documentPayment.findFirstOrThrow({ where: { documentId: cashDocId } });
    expect(pay.sriCode).toBe('01'); // no "99"
  });

  it('pago mixto: tarjeta de crédito se registra con el código 19 del parámetro', async () => {
    const res = await http()
      .post('/api/einvoice/invoices')
      .set(auth())
      .send(sale([{ sriCode: '01', method: 'efectivo', amount: '5.00', cashReceived: '5' }, { sriCode: '01', method: 'tarjeta_credito', amount: '6.50', reference: 'VOUCHER 123' }]))
      .expect(201);
    const pays = await owner.documentPayment.findMany({ where: { documentId: res.body.documentId }, orderBy: { method: 'asc' } });
    expect(pays.map((p) => [p.method, p.sriCode])).toEqual([
      ['efectivo', '01'],
      ['tarjeta_credito', '19'],
    ]);
  });

  it('venta a crédito exige cliente identificado', async () => {
    const res = await http().post('/api/einvoice/invoices').set(auth()).send(sale([{ sriCode: '01', method: 'credito', amount: '11.50' }])).expect(422);
    expect(res.body.message).toMatch(/crédito requieren un cliente identificado/);
  });

  it('egreso de caja y arqueo: efectivo esperado = apertura + ventas en efectivo − egresos', async () => {
    await http().post(`/api/cash/sessions/${sessionId}/movements`).set(auth()).send({ type: 'OUT', amount: '3.00', reason: 'Pago de agua' }).expect(201);
    const s = await http().get(`/api/cash/sessions/${sessionId}`).set(auth()).expect(200);
    // 20 + 11.50 + 5.00 − 3.00 = 33.50
    expect(s.body.cash).toEqual({ opening: '20.00', sales: '16.50', in: '0.00', out: '3.00', expected: '33.50' });
    expect(s.body.methods.find((m: { method: string }) => m.method === 'tarjeta_credito')).toMatchObject({ sales: '6.50', expected: '6.50', count: 1 });
    expect(s.body).toMatchObject({ invoices: 2, totalSales: '23.00' });
    expect(s.body.byUser[0]).toMatchObject({ invoices: 2, total: '23.00' });
  });

  it('cierre con faltante de $0,50 queda registrado; ya no se puede vender en esa caja', async () => {
    const res = await http()
      .post(`/api/cash/sessions/${sessionId}/close`)
      .set(auth())
      .send({ counted: { efectivo: '33.00', tarjeta_credito: '6.50' }, denominations: { '20': 1, '10': 1, '1': 3 }, notes: 'Faltan 50 ctvs' })
      .expect(200);
    expect(res.body).toMatchObject({ status: 'CLOSED', difference: '-0.50' });
    expect(res.body.methods.find((m: { method: string }) => m.method === 'efectivo')).toMatchObject({ expected: '33.50', counted: '33.00', difference: '-0.50' });
    await http().post('/api/einvoice/invoices').set(auth()).send(sale([{ sriCode: '01', method: 'efectivo', amount: '11.50' }])).expect(422);
    await http().post(`/api/cash/sessions/${sessionId}/close`).set(auth()).send({ counted: {} }).expect(422);
  });

  it('un cajero sin permiso de descuento no puede aplicar descuentos', async () => {
    const roles = (await http().get('/api/roles').set(auth())).body;
    const cashierRole = roles.find((r: { systemCode: string }) => r.systemCode === 'CASHIER');
    const email = uniqueEmail('cajero');
    await http().post('/api/users').set(auth()).send({ email, fullName: 'Cajero', password: 'Cajero.2026', roleIds: [cashierRole.id] }).expect(201);
    const cashierToken = await tokenFor(app, email).catch(async () => (await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'Cajero.2026' })).body.accessToken);
    const open = await http().post('/api/cash/sessions').set(auth(cashierToken)).send({ emissionPointId: T.emissionPointId, openingAmount: '0' }).expect(201);
    sessionId = open.body.id;
    const withDiscount = sale([{ sriCode: '01', method: 'efectivo', amount: '10.35' }], {
      lines: [{ productId: product.id, description: 'Martillo', quantity: '1', unitPrice: '10', discount: '1.00', taxRateId: product.taxRateId }],
    });
    const res = await http().post('/api/einvoice/invoices').set(auth(cashierToken)).send(withDiscount).expect(403);
    expect(res.body.message).toMatch(/descuentos/);
    await http().post('/api/einvoice/invoices').set(auth(cashierToken)).send(sale([{ sriCode: '01', method: 'efectivo', amount: '11.50' }])).expect(201);
  });

  it('proforma: se crea, se convierte en factura una sola vez', async () => {
    const q = await http()
      .post('/api/quotes')
      .set(auth())
      .send({
        emissionPointId: T.emissionPointId,
        buyer: { idType: '05', id: '1710034065', name: 'Juan Pérez', email: 'juan@example.com' },
        lines: [{ productId: product.id, code: 'MART', description: 'Martillo', quantity: '3', unitPrice: '10', discount: '0', taxRateId: product.taxRateId }],
        validDays: 15,
      })
      .expect(201);
    expect(q.body).toMatchObject({ number: '000000001', total: '34.50', documentId: null, expired: false });
    const pending = await http().get('/api/quotes').query({ pending: 'true' }).set(auth()).expect(200);
    expect(pending.body.items.map((i: { id: string }) => i.id)).toContain(q.body.id);

    const invoice = sale([{ sriCode: '01', method: 'efectivo', amount: '34.50' }], {
      quoteId: q.body.id,
      buyer: { idType: '05', id: '1710034065', name: 'Juan Pérez' },
      lines: [{ productId: product.id, description: 'Martillo', quantity: '3', unitPrice: '10', taxRateId: product.taxRateId }],
    });
    const inv = await http().post('/api/einvoice/invoices').set(auth()).send(invoice).expect(201);
    expect((await http().get(`/api/quotes/${q.body.id}`).set(auth())).body.documentId).toBe(inv.body.documentId);
    const again = await http().post('/api/einvoice/invoices').set(auth()).send(invoice).expect(422);
    expect(again.body.message).toMatch(/ya fue facturada/);
  });

  it('link público del RIDE funciona sin sesión y rechaza enlaces alterados', async () => {
    const ticket = (await http().get(`/api/pos/tickets/${cashDocId}`).set(auth())).body;
    const path = new URL(ticket.publicRideUrl).pathname;
    const pdf = await http().get(path).buffer(true).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    const xml = await http().get(path.replace(/\/ride$/, '/xml')).expect(200);
    expect(xml.headers['content-type']).toContain('application/xml');
    const token = path.split('/')[4];
    const tampered = `${token.slice(0, -2)}xx`;
    await http().get(`/api/public/documents/${tampered}/ride`).expect(404);
  });
});
