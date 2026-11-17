/**
 * Fase 7: cuentas por cobrar y por pagar.
 */
import type { INestApplication } from '@nestjs/common';
import { PrismaClient, ProvisionTenantResult, seedSriConfig, withContext } from '@vektra/db';
import { invalidateSriSettings } from '@vektra/einvoice';
import { buildAccessKey, buildWithholdingXml, parseInvoiceXml } from '@vektra/sri-core';
import { createTestP12 } from '@vektra/sri-core/testing';
import request from 'supertest';
import { FakeSri } from './fake-sri';
import { appClient, createApp, makeTenant, ownerClient, randomRuc, seedPermissions, tokenFor, uniqueEmail } from './helpers';

describe('Cuentas por cobrar y por pagar', () => {
  let owner: PrismaClient;
  let db: PrismaClient;
  let app: INestApplication;
  let T: ProvisionTenantResult;
  let tenantRuc: string;
  let token: string;
  let product: { id: string; taxRateId: string };
  let sessionId: string;
  let customer: { id: string; ruc: string };
  const sri = new FakeSri();
  const http = () => request(app.getHttpServer());
  const auth = () => ({ authorization: `Bearer ${token}` });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
  const daysFrom = (n: number) => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  const creditSale = (buyer: { idType: string; id: string; name: string }, qty: string, total: string, extra: object[] = []) =>
    http()
      .post('/api/einvoice/invoices')
      .set(auth())
      .send({
        emissionPointId: T.emissionPointId,
        cashSessionId: sessionId,
        buyer,
        lines: [{ productId: product.id, description: 'Taladro', quantity: qty, unitPrice: '40', taxRateId: product.taxRateId }],
        payments: [{ sriCode: '01', method: 'credito', amount: total }, ...extra],
      });

  const statement = async (side: 'AR' | 'AP', partyId: string) => (await http().get(`/api/accounts/${side}/parties/${partyId}`).set(auth()).expect(200)).body;

  beforeAll(async () => {
    owner = ownerClient();
    db = appClient();
    await seedPermissions(owner);
    await seedSriConfig(owner);
    await sri.start();
    await owner.sriSetting.update({ where: { key: 'ws.test' }, data: { value: { reception: sri.receptionUrl, authorization: sri.authorizationUrl } } });
    invalidateSriSettings();
    const email = uniqueEmail('cuentas');
    tenantRuc = randomRuc();
    T = await makeTenant(owner, tenantRuc, email, 'hardware');
    app = await createApp({ REDIS_URL: 'redis://127.0.0.1:6390/5' });
    token = await tokenFor(app, email);
    await http().post('/api/einvoice/certificate').set(auth()).attach('file', createTestP12('k123'), 'f.p12').field('password', 'k123').expect(200);
    const lk = (await http().get('/api/catalog/lookups').set(auth())).body;
    const iva15 = lk.taxRates.find((r: { percentageCode: string }) => r.percentageCode === '4').id;
    const und = lk.units.find((u: { code: string }) => u.code === 'UND').id;
    const pub = lk.priceLists.find((l: { code: string }) => l.code === 'PUBLICO').id;
    const created = await http().post('/api/products').set(auth()).send({ code: 'TAL', name: 'Taladro', unitId: und, taxRateId: iva15, prices: [{ priceListId: pub, unitId: und, price: '40' }] }).expect(201);
    product = { id: created.body.id, taxRateId: iva15 };
    await http().post('/api/inventory/adjustments').set(auth()).send({ warehouseId: T.warehouseId, direction: 'IN', reason: 'Saldo inicial', items: [{ productId: product.id, quantity: '50', unitCost: '25' }] }).expect(201);
    sessionId = (await http().post('/api/cash/sessions').set(auth()).send({ emissionPointId: T.emissionPointId, openingAmount: '0' }).expect(201)).body.id;
    const ruc = randomRuc();
    const party = await http()
      .post('/api/parties')
      .set(auth())
      .send({ idType: '04', identification: ruc, name: 'CONSTRUCTORA ANDINA S.A.', isCustomer: true, creditLimit: '100', creditDays: 30 })
      .expect(201);
    customer = { id: party.body.id, ruc };
  });

  afterAll(async () => {
    await app.close();
    await sri.stop();
    await db.$disconnect();
    await owner.$disconnect();
  });

  const buyer = () => ({ idType: '04', id: customer.ruc, name: 'CONSTRUCTORA ANDINA S.A.' });
  let invoiceId: string;
  let invoiceNumber: string;
  let itemId: string;

  it('venta a crédito: exige cliente con crédito aprobado y crea la cuenta por cobrar con su plazo', async () => {
    const noLimit = await creditSale({ idType: '05', id: '1710034065', name: 'Sin crédito' }, '1', '46.00').expect(422);
    expect(noLimit.body.message).toMatch(/registre primero al cliente|crédito aprobado/);
    const res = await creditSale(buyer(), '1', '46.00').expect(201);
    invoiceId = res.body.documentId;
    invoiceNumber = res.body.number;
    const st = await statement('AR', customer.id);
    expect(st).toMatchObject({ owed: '46.00', overdue: '0.00', credit: '0.00', available: '54.00' });
    expect(st.items[0]).toMatchObject({ number: invoiceNumber, amount: '46.00', balance: '46.00', status: 'OPEN', dueDate: daysFrom(30), sourceType: 'INVOICE' });
    itemId = st.items[0].id;
    // El plazo va en el XML de la factura
    const edoc = await withContext(db, { tenantId: T.tenantId }, (tx) => tx.electronicDocument.findUniqueOrThrow({ where: { documentId: invoiceId } }));
    expect(parseInvoiceXml(edoc.signedXml as string).payments[0]).toMatchObject({ code: '01', term: '30', timeUnit: 'dias' });
  });

  it('no deja pasar el límite de crédito', async () => {
    const r = await creditSale(buyer(), '2', '92.00').expect(422);
    expect(r.body.message).toMatch(/Crédito insuficiente.*disponible \$54\.00/);
  });

  it('abono en efectivo: entra a la caja abierta y baja el saldo', async () => {
    await http().post('/api/accounts/AR/payments').set(auth()).send({ partyId: customer.id, date: today, method: 'efectivo', amount: '20', cashSessionId: sessionId }).expect(201);
    const st = await statement('AR', customer.id);
    expect(st.items[0]).toMatchObject({ balance: '26.00', status: 'OPEN' });
    const cash = (await http().get(`/api/cash/sessions/${sessionId}`).set(auth()).expect(200)).body;
    expect(cash.cash.in).toBe('20.00');
  });

  it('retención recibida del cliente: se lee del XML, se aplica a la factura y no se registra dos veces', async () => {
    const xml = buildWithholdingXml({
      version: '2.0.0',
      environment: 1,
      accessKey: buildAccessKey({ issueDate: { day: 17, month: 11, year: 2026 }, docType: '07', ruc: customer.ruc, environment: 1, establishment: '001', emissionPoint: '001', sequential: 55 }),
      establishment: '001',
      emissionPoint: '001',
      sequential: '000000055',
      issueDate: { day: 17, month: 11, year: 2026 },
      issuer: { ruc: customer.ruc, legalName: 'CONSTRUCTORA ANDINA S.A.', mainAddress: 'Quito', keepsAccounting: true },
      subject: { idType: '04', id: tenantRuc, name: 'MI EMPRESA', relatedParty: false },
      fiscalPeriod: { month: 11, year: 2026 },
      support: {
        sustentoCode: '06',
        docType: '01',
        number: invoiceNumber,
        issueDate: { day: 17, month: 11, year: 2026 },
        subtotal: '40.00',
        total: '46.00',
        taxes: [{ taxCode: '2', percentageCode: '4', base: '40.00', rate: '15', amount: '6.00' }],
        payments: [{ code: '20', amount: '46.00' }],
      },
      items: [
        { tax: '1', code: '312', base: '40.00', percentage: '2', amount: '0.80' },
        { tax: '2', code: '1', base: '6.00', percentage: '30', amount: '1.80' },
      ],
      additionalInfo: [],
    });
    const p = (await http().post('/api/accounts/AR/withholdings/xml-preview').set(auth()).attach('file', Buffer.from(xml), 'ret.xml').expect(200)).body;
    expect(p).toMatchObject({ partyId: customer.id, itemId, invoiceNumber, number: '001-001-000000055', total: '2.60', warnings: [] });
    const body = { itemId: p.itemId, number: p.number, authorization: p.authorization, date: p.date, items: p.items };
    await http().post('/api/accounts/AR/withholdings').set(auth()).send(body).expect(201);
    expect((await statement('AR', customer.id)).items[0].balance).toBe('23.40');
    await http().post('/api/accounts/AR/withholdings').set(auth()).send(body).expect(422);
    // Valores que no cuadran se rechazan
    await http().post('/api/accounts/AR/withholdings').set(auth()).send({ ...body, number: '001-001-000000056', items: [{ tax: '1', code: '312', base: '40', percentage: '2', amount: '0.90' }] }).expect(422);
  });

  it('nota de crédito con reembolso a crédito: cancela la deuda y el exceso queda como saldo a favor', async () => {
    const c = (await http().get(`/api/einvoice/documents/${invoiceId}/creditable`).set(auth()).expect(200)).body;
    await http()
      .post('/api/einvoice/credit-notes')
      .set(auth())
      .send({ invoiceId, emissionPointId: T.emissionPointId, reason: 'Devolución', lines: [{ sourceLineId: c.lines[0].id, quantity: '1' }], refund: { method: 'credito' } })
      .expect(201);
    const st = await statement('AR', customer.id);
    expect(st.items[0]).toMatchObject({ balance: '0.00', status: 'PAID' });
    expect(st.credit).toBe('22.60'); // 46 − 23.40
    expect(st.movements.find((m: { kind: string }) => m.kind === 'CREDIT_NOTE')).toMatchObject({ amount: '46.00', unapplied: '22.60' });
  });

  it('el saldo a favor se usa en la siguiente compra a crédito', async () => {
    const res = await creditSale(buyer(), '1', '46.00').expect(201);
    let st = await statement('AR', customer.id);
    const nc = st.movements.find((m: { kind: string }) => m.kind === 'CREDIT_NOTE');
    const item = st.items.find((i: { sourceId: string }) => i.sourceId === res.body.documentId);
    await http().post('/api/accounts/AR/apply-credit').set(auth()).send({ movementId: nc.id, itemId: item.id, amount: '22.60' }).expect(204);
    await http().post('/api/accounts/AR/apply-credit').set(auth()).send({ movementId: nc.id, itemId: item.id, amount: '1' }).expect(422);
    st = await statement('AR', customer.id);
    expect(st).toMatchObject({ owed: '23.40', credit: '0.00' });
  });

  it('antigüedad de saldos y anulación de un cobro (el efectivo sale de la caja)', async () => {
    await http()
      .post('/api/accounts/AR/openings')
      .set(auth())
      .send({ partyId: customer.id, number: 'SALDO-2025-01', issueDate: daysFrom(-75), dueDate: daysFrom(-45), amount: '150', notes: 'Saldo anterior al sistema' })
      .expect(201);
    const ov = (await http().get('/api/accounts/AR').set(auth()).expect(200)).body;
    const row = ov.items.find((i: { partyId: string }) => i.partyId === customer.id);
    expect(row).toMatchObject({ owed: '173.40', overdue: '150.00', buckets: { current: '23.40', d60: '150.00' } });
    // Cobro que se aplica al más antiguo y luego se anula
    const pay = await http().post('/api/accounts/AR/payments').set(auth()).send({ partyId: customer.id, date: today, method: 'efectivo', amount: '50', cashSessionId: sessionId }).expect(201);
    let st = await statement('AR', customer.id);
    expect(st.items.find((i: { number: string }) => i.number === 'SALDO-2025-01').balance).toBe('100.00');
    await http().post(`/api/accounts/AR/movements/${pay.body.id}/void`).set(auth()).send({ reason: 'Error de digitación' }).expect(204);
    st = await statement('AR', customer.id);
    expect(st.items.find((i: { number: string }) => i.number === 'SALDO-2025-01').balance).toBe('150.00');
    const cash = (await http().get(`/api/cash/sessions/${sessionId}`).set(auth()).expect(200)).body;
    expect(cash.cash).toMatchObject({ in: '70.00', out: '50.00' });
  });

  // ───────── Por pagar ─────────

  it('compra a crédito, retención emitida y pago: el saldo con el proveedor cuadra', async () => {
    const lk = (await http().get('/api/catalog/lookups').set(auth())).body;
    const iva15 = lk.taxRates.find((r: { percentageCode: string }) => r.percentageCode === '4').id;
    const ruc = randomRuc();
    const sup = await http().post('/api/parties').set(auth()).send({ idType: '04', identification: ruc, name: 'FERRO DISTRIBUIDOR S.A.', isCustomer: false, isSupplier: true, creditDays: 45 }).expect(201);
    const pur = await http()
      .post('/api/purchases')
      .set(auth())
      .send({ supplierId: sup.body.id, number: '001-001-000001234', issueDate: today, warehouseId: T.warehouseId, lines: [{ productId: product.id, description: 'Taladro', quantity: '10', unitCost: '20', taxRateId: iva15 }] })
      .expect(201);
    let st = await statement('AP', sup.body.id);
    expect(st.items[0]).toMatchObject({ amount: '230.00', balance: '230.00', dueDate: daysFrom(45), sourceType: 'PURCHASE' });
    const codes = (await http().get('/api/tax/withholding-codes').set(auth())).body;
    const c312 = codes.find((c: { tax: string; code: string }) => c.tax === '1' && c.code === '312').id;
    await http()
      .post('/api/einvoice/withholdings')
      .set(auth())
      .send({ purchaseId: pur.body.id, emissionPointId: T.emissionPointId, sustentoCode: '06', paymentCode: '20', items: [{ withholdingCodeId: c312, base: '200' }] })
      .expect(201);
    st = await statement('AP', sup.body.id);
    expect(st.items[0].balance).toBe('226.00'); // 230 − 2 % de 200
    await http().post('/api/accounts/AP/payments').set(auth()).send({ partyId: sup.body.id, date: today, method: 'transferencia', amount: '226', reference: 'TRF 991' }).expect(201);
    st = await statement('AP', sup.body.id);
    expect(st).toMatchObject({ owed: '0.00' });
    expect(st.items[0].status).toBe('PAID');
    // Con pagos aplicados ya no se puede anular la compra
    const v = await http().post(`/api/purchases/${pur.body.id}/void`).set(auth()).send({ reason: 'Prueba' }).expect(422);
    expect(v.body.message).toMatch(/pagos o retención/);
  });

  it('compra al contado en efectivo: queda pagada y sale de la caja', async () => {
    const lk = (await http().get('/api/catalog/lookups').set(auth())).body;
    const iva15 = lk.taxRates.find((r: { percentageCode: string }) => r.percentageCode === '4').id;
    const pur = await http()
      .post('/api/purchases')
      .set(auth())
      .send({
        newSupplier: { idType: '04', identification: randomRuc(), name: 'FERRETERIA VECINA' },
        number: '001-001-000000009',
        issueDate: today,
        warehouseId: T.warehouseId,
        payment: { mode: 'CASH', method: 'efectivo', cashSessionId: sessionId },
        lines: [{ description: 'Cinta de embalaje', quantity: '2', unitCost: '5', taxRateId: iva15 }],
      })
      .expect(201);
    const d = (await http().get(`/api/purchases/${pur.body.id}`).set(auth()).expect(200)).body;
    expect(d.payable).toMatchObject({ balance: '0.00', status: 'PAID' });
    const cash = (await http().get(`/api/cash/sessions/${sessionId}`).set(auth()).expect(200)).body;
    expect(cash.cash.out).toBe('61.50'); // 50 (anulación del cobro) + 11.50
  });
});
