/**
 * Fase 8: reportes y ATS (Anexo Transaccional Simplificado).
 */
import type { INestApplication } from '@nestjs/common';
import { PrismaClient, ProvisionTenantResult, seedSriConfig } from '@vektra/db';
import { authorizeStep, invalidateSriSettings, sendStep } from '@vektra/einvoice';
import { validateAts } from '@vektra/sri-core';
import { createTestP12 } from '@vektra/sri-core/testing';
import { inflateRawSync } from 'node:zlib';
import request from 'supertest';
import { FakeSri } from './fake-sri';
import { appClient, createApp, makeTenant, ownerClient, randomRuc, seedPermissions, tokenFor, uniqueEmail } from './helpers';

describe('Reportes y ATS', () => {
  let owner: PrismaClient;
  let db: PrismaClient;
  let app: INestApplication;
  let T: ProvisionTenantResult;
  let token: string;
  let iva15: string;
  let product: string;
  let sessionId: string;
  let customer: { id: string; ruc: string };
  let purchaseA: string;
  let purchaseB: string;
  const sri = new FakeSri();
  const http = () => request(app.getHttpServer());
  const auth = () => ({ authorization: `Bearer ${token}` });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
  const [year, month] = today.split('-').map(Number);
  const authorize = async (id: string) => {
    await sendStep({ prisma: db }, T.tenantId, id);
    await authorizeStep({ prisma: db }, T.tenantId, id);
  };
  const report = (kind: string, extra = '') => http().get(`/api/reports?kind=${kind}&from=${today}&to=${today}${extra}`).set(auth());
  const ats = (format = 'json') => http().get(`/api/reports/ats?year=${year}&month=${month}&format=${format}`).set(auth());
  const sell = (buyer: object, qty: string, total: string, method = 'efectivo', sriCode = '01') =>
    http()
      .post('/api/einvoice/invoices')
      .set(auth())
      .send({
        emissionPointId: T.emissionPointId,
        cashSessionId: sessionId,
        buyer,
        lines: [{ productId: product, description: 'Taladro', quantity: qty, unitPrice: '40', taxRateId: iva15 }],
        payments: [{ sriCode, method, amount: total }],
      })
      .expect(201);

  beforeAll(async () => {
    owner = ownerClient();
    db = appClient();
    await seedPermissions(owner);
    await seedSriConfig(owner);
    await sri.start();
    await owner.sriSetting.update({ where: { key: 'ws.test' }, data: { value: { reception: sri.receptionUrl, authorization: sri.authorizationUrl } } });
    await owner.sriSetting.update({ where: { key: 'authorization.wait_seconds' }, data: { value: 0 } });
    invalidateSriSettings();
    const email = uniqueEmail('reportes');
    T = await makeTenant(owner, randomRuc(), email, 'hardware');
    app = await createApp({ REDIS_URL: 'redis://127.0.0.1:6390/5' });
    token = await tokenFor(app, email);
    await http().post('/api/einvoice/certificate').set(auth()).attach('file', createTestP12('k123'), 'f.p12').field('password', 'k123').expect(200);
    const lk = (await http().get('/api/catalog/lookups').set(auth())).body;
    iva15 = lk.taxRates.find((r: { percentageCode: string }) => r.percentageCode === '4').id;
    const und = lk.units.find((u: { code: string }) => u.code === 'UND').id;
    const pub = lk.priceLists.find((l: { code: string }) => l.code === 'PUBLICO').id;
    product = (await http().post('/api/products').set(auth()).send({ code: 'TAL', name: 'Taladro', unitId: und, taxRateId: iva15, prices: [{ priceListId: pub, unitId: und, price: '40' }] }).expect(201)).body.id;
    await http().post('/api/inventory/adjustments').set(auth()).send({ warehouseId: T.warehouseId, direction: 'IN', reason: 'Saldo inicial', items: [{ productId: product, quantity: '50', unitCost: '25' }] }).expect(201);
    sessionId = (await http().post('/api/cash/sessions').set(auth()).send({ emissionPointId: T.emissionPointId, openingAmount: '10' }).expect(201)).body.id;
    const ruc = randomRuc();
    const party = await http()
      .post('/api/parties')
      .set(auth())
      .send({ idType: '04', identification: ruc, name: 'CONSTRUCTORA ANDINA S.A.', isCustomer: true, creditLimit: '500', creditDays: 30, relatedParty: true })
      .expect(201);
    customer = { id: party.body.id, ruc };

    // Ventas: a crédito al cliente (2 u.), a consumidor final (1 u.) y otra sin autorizar todavía
    const s1 = await sell({ idType: '04', id: ruc, name: 'CONSTRUCTORA ANDINA S.A.' }, '2', '92.00', 'credito', '01');
    await authorize(s1.body.documentId);
    const s2 = await sell({ idType: '07', id: '9999999999999', name: 'CONSUMIDOR FINAL' }, '1', '46.00', 'transferencia', '20');
    await authorize(s2.body.documentId);
    await sell({ idType: '07', id: '9999999999999', name: 'CONSUMIDOR FINAL' }, '1', '46.00');

    // Retención que hizo el cliente sobre la factura a crédito
    const item = (await http().get(`/api/accounts/AR/parties/${customer.id}`).set(auth()).expect(200)).body.items[0];
    await http()
      .post('/api/accounts/AR/withholdings')
      .set(auth())
      .send({
        itemId: item.id,
        number: '001-001-000000321',
        authorization: '2'.repeat(49),
        date: today,
        items: [
          { tax: '2', code: '1', base: '12.00', percentage: '30', amount: '3.60' },
          { tax: '1', code: '312C', base: '80.00', percentage: '1.75', amount: '1.40' },
        ],
      })
      .expect(201);

    // Devolución de 1 taladro de la factura a crédito
    const c = (await http().get(`/api/einvoice/documents/${s1.body.documentId}/creditable`).set(auth()).expect(200)).body;
    const nc = await http()
      .post('/api/einvoice/credit-notes')
      .set(auth())
      .send({ invoiceId: s1.body.documentId, emissionPointId: T.emissionPointId, reason: 'Devolución', lines: [{ sourceLineId: c.lines[0].id, quantity: '1' }], refund: { method: 'credito' } })
      .expect(201);
    await authorize(nc.body.documentId);

    // Compra A: con sustento y forma de pago; se le emite retención (renta 307 + IVA 70 %)
    purchaseA = (
      await http()
        .post('/api/purchases')
        .set(auth())
        .send({
          newSupplier: { idType: '04', identification: randomRuc(), name: 'SERVICIOS TÉCNICOS & CÍA. LTDA.' },
          number: '002-001-000000777',
          authorization: '1'.repeat(49),
          issueDate: today,
          warehouseId: T.warehouseId,
          sustentoCode: '02',
          paymentCode: '20',
          lines: [{ description: 'Mantenimiento', quantity: '1', unitCost: '1000', taxRateId: iva15 }],
        })
        .expect(201)
    ).body.id;
    const codes = (await http().get('/api/tax/withholding-codes').set(auth()).expect(200)).body as { id: string; tax: string; code: string }[];
    const code = (tax: string, c2: string) => codes.find((x) => x.tax === tax && x.code === c2)!.id;
    const draft = (await http().get(`/api/einvoice/purchases/${purchaseA}/withholding-draft`).set(auth()).expect(200)).body;
    expect(draft.previous).toMatchObject({ sustentoCode: '02', paymentCode: '20' });
    const w = await http()
      .post('/api/einvoice/withholdings')
      .set(auth())
      .send({
        purchaseId: purchaseA,
        emissionPointId: T.emissionPointId,
        sustentoCode: '02',
        paymentCode: '20',
        items: [
          { withholdingCodeId: code('1', '307'), base: '1000' },
          { withholdingCodeId: code('2', '2'), base: '150' },
        ],
      })
      .expect(201);
    await authorize(w.body.documentId);

    // Compra B: al contado en efectivo, sin sustento todavía y sin retención
    purchaseB = (
      await http()
        .post('/api/purchases')
        .set(auth())
        .send({
          newSupplier: { idType: '04', identification: randomRuc(), name: 'FERRETERIA MAYORISTA S.A.' },
          number: '001-002-000004321',
          authorization: '3'.repeat(49),
          issueDate: today,
          warehouseId: T.warehouseId,
          payment: { mode: 'CASH', method: 'efectivo' },
          lines: [{ productId: product, description: 'Taladro', quantity: '4', unitCost: '25', taxRateId: iva15 }],
        })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await app.close();
    await sri.stop();
    await db.$disconnect();
    await owner.$disconnect();
  });

  it('ATS: la revisión previa señala lo que falta y no deja descargar', async () => {
    const p = (await ats().expect(200)).body;
    expect(p.valid).toBe(false);
    expect(p.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: 'error', message: expect.stringMatching(/001-002-000004321.*falta el sustento tributario/), link: `/compras?ver=${purchaseB}` }),
        expect.objectContaining({ level: 'warning', message: expect.stringMatching(/1 comprobante\(s\) de venta del período aún no están autorizados/) }),
      ]),
    );
    const r = await ats('xml').expect(422);
    expect(r.body.message).toMatch(/No se puede generar el ATS: .*sustento/);
  });

  it('ATS: se corrige la compra y el anexo cumple el XSD del DIMM', async () => {
    const detail = (await http().get(`/api/purchases/${purchaseB}`).set(auth()).expect(200)).body;
    expect(detail).toMatchObject({ sustentoCode: null, paymentCode: '01', relatedParty: false }); // efectivo → 01
    await http().post(`/api/purchases/${purchaseB}/ats`).set(auth()).send({ sustentoCode: '07', paymentCode: '01', relatedParty: false }).expect(204);

    const p = (await ats().expect(200)).body;
    expect(p.issues.filter((i: { level: string }) => i.level === 'error')).toEqual([]);
    expect(p).toMatchObject({
      valid: true,
      xsdErrors: [],
      fileName: `AT${String(month).padStart(2, '0')}${year}`,
      totalSales: '80.00', // 80 + 40 − 40
      purchases: { count: 2, base: '1100.00', iva: '165.00', ivaWithheld: '105.00', rentaWithheld: '30.00' },
      sales: { rows: 3, documents: 2, base: '120.00', iva: '18.00', ivaWithheld: '3.60', rentaWithheld: '1.40' },
      creditNotes: { documents: 1, base: '40.00' },
      salesByEstablishment: [{ code: '001', total: '80.00' }],
    });

    const xml = (await ats('xml').expect(200)).text;
    expect((await validateAts(xml)).errors).toEqual([]);
    // Compra A: retención de IVA 70 % y renta 307, con el comprobante de retención
    expect(xml).not.toContain('<denoProv>'); // la razón social del proveedor solo se informa con pasaporte
    expect(xml).toMatch(/<codSustento>02<\/codSustento>.*<valorRetServicios>105\.00<\/valorRetServicios>.*<formaPago>20<\/formaPago>.*<codRetAir>307<\/codRetAir><baseImpAir>1000\.00<\/baseImpAir><porcentajeAir>3\.00<\/porcentajeAir><valRetAir>30\.00<\/valRetAir>.*<estabRetencion1>001<\/estabRetencion1>/s);
    // Compra B: sin retención → concepto 332 al 0 %, sin forma de pago (no supera USD 500)
    expect(xml).toMatch(/<codSustento>07<\/codSustento>.*<secuencial>4321<\/secuencial>.*<pagoExterior>.*<\/pagoExterior><air><detalleAir><codRetAir>332<\/codRetAir><baseImpAir>100\.00<\/baseImpAir><porcentajeAir>0\.00<\/porcentajeAir>/s);
    // Ventas: cliente (parte relacionada) con retenciones, su nota de crédito y consumidor final
    expect(xml).toContain(
      `<tpIdCliente>04</tpIdCliente><idCliente>${customer.ruc}</idCliente><parteRelVtas>SI</parteRelVtas><tipoComprobante>18</tipoComprobante><tipoEmision>E</tipoEmision><numeroComprobantes>1</numeroComprobantes><baseNoGraIva>0.00</baseNoGraIva><baseImponible>0.00</baseImponible><baseImpGrav>80.00</baseImpGrav><montoIva>12.00</montoIva><montoIce>0.00</montoIce><valorRetIva>3.60</valorRetIva><valorRetRenta>1.40</valorRetRenta><formasDePago><formaPago>01</formaPago></formasDePago>`,
    );
    expect(xml).toContain(`<idCliente>${customer.ruc}</idCliente><parteRelVtas>SI</parteRelVtas><tipoComprobante>04</tipoComprobante>`);
    expect(xml).toContain('<tpIdCliente>07</tpIdCliente><idCliente>9999999999999</idCliente><tipoComprobante>18</tipoComprobante><tipoEmision>E</tipoEmision><numeroComprobantes>1</numeroComprobantes>');

    const zip = await ats('zip').buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    const buf = zip.body as Buffer;
    expect(zip.headers['content-disposition']).toContain(`AT${String(month).padStart(2, '0')}${year}.zip`);
    const nameLen = buf.readUInt16LE(26);
    expect(inflateRawSync(buf.subarray(30 + nameLen, 30 + nameLen + buf.readUInt32LE(18))).toString('latin1')).toBe(xml);
  });

  it('reportes de ventas: por día, producto, forma de pago y usuario', async () => {
    const daily = (await report('sales_daily').expect(200)).body;
    // 3 facturas (una aún sin autorizar) − 1 nota de crédito
    expect(daily.totals).toMatchObject({ invoices: 3, creditNotes: 1, subtotal: 120, tax: 18, total: 138 });
    const prod = (await report('sales_product').expect(200)).body;
    expect(prod.rows).toEqual([expect.objectContaining({ code: 'TAL', qty: 3, net: 120, share: 100 })]);
    const pay = (await report('sales_payment').expect(200)).body;
    expect(pay.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'Crédito', docs: 1, amount: 92 }),
        expect.objectContaining({ method: 'Efectivo', docs: 1, amount: 46 }),
        expect.objectContaining({ method: 'Transferencia', sri: expect.stringMatching(/^20 /), amount: 46 }),
      ]),
    );
    const users = (await report('sales_user').expect(200)).body;
    expect(users.totals).toMatchObject({ invoices: 3, creditNotes: 1, total: 138 });
  });

  it('utilidad e inventario valorizado al costo promedio', async () => {
    const profit = (await report('profit').expect(200)).body;
    // 4 vendidos − 1 devuelto = 3 × costo 25
    expect(profit.rows[0]).toMatchObject({ code: 'TAL', net: 120, cost: 75, profit: 45, margin: 37.5 });
    const inv = (await report('inventory').expect(200)).body;
    // 50 − 4 + 1 + 4 comprados = 51 a 25
    expect(inv.rows[0]).toMatchObject({ code: 'TAL', qty: 51, avgCost: 25, value: 1275 });
  });

  it('compras por proveedor, resumen de IVA, cartera y cierres de caja', async () => {
    const pur = (await report('purchases_supplier').expect(200)).body;
    expect(pur.totals).toMatchObject({ docs: 2, subtotal: 1100, tax: 165, total: 1265, withheld: 135, payable: 1130 });
    const vat = (await report('vat').expect(200)).body;
    expect(vat.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ section: 'Ventas (facturas − notas de crédito)', concept: 'IVA 15%', base: 120, amount: 18 }),
        expect.objectContaining({ section: 'Compras', concept: 'IVA 15%', base: 1100, amount: 165 }),
        expect.objectContaining({ section: 'Retenciones de IVA efectuadas', base: 150, amount: 105 }),
        expect.objectContaining({ section: 'Retenciones de renta efectuadas', concept: 'Código 307 (3%)', amount: 30 }),
        expect.objectContaining({ section: 'Retenciones de IVA que le hicieron', amount: 3.6 }),
        expect.objectContaining({ section: 'Retenciones de renta que le hicieron', amount: 1.4 }),
      ]),
    );
    expect(vat.totals).toMatchObject({ amount: -147 });
    const ar = (await report('receivables').expect(200)).body;
    expect(ar.rows).toEqual([expect.objectContaining({ name: 'CONSTRUCTORA ANDINA S.A.', amount: 92, balance: 41, bucket: 'Por vencer' })]);
    const ap = (await report('payables').expect(200)).body;
    expect(ap.totals).toMatchObject({ balance: 1015 }); // 1150 − 135 retenido (la compra B se pagó al contado)
    const cash = (await report('cash_sessions').expect(200)).body;
    expect(cash.rows).toEqual([expect.objectContaining({ closedAt: 'Abierta', opening: 10 })]);
  });

  it('exporta a Excel y valida filtros', async () => {
    const x = await report('sales_daily', '&format=xlsx').expect(200);
    expect(x.headers['content-type']).toContain('spreadsheetml');
    expect(x.headers['content-disposition']).toContain(`sales_daily_${today}_${today}.xlsx`);
    const bad = await http().get(`/api/reports?kind=sales_daily&from=${today}&to=2000-01-01`).set(auth()).expect(400);
    expect(JSON.stringify(bad.body)).toMatch(/fecha inicial no puede ser posterior/);
    await http().get(`/api/reports/ats?year=${year}&month=5&semiannual=true`).set(auth()).expect(400);
  });
});
