/**
 * Fase 5: notas de crédito (devoluciones) y compras a proveedores.
 */
import type { INestApplication } from '@nestjs/common';
import { PrismaClient, ProvisionTenantResult, seedSriConfig, withContext } from '@vektra/db';
import { authorizeStep, invalidateSriSettings, sendStep } from '@vektra/einvoice';
import { buildAccessKey, buildInvoiceXml, computeInvoice, parseCreditNoteXml, validateAgainstXsd } from '@vektra/sri-core';
import { createTestP12 } from '@vektra/sri-core/testing';
import request from 'supertest';
import { FakeSri } from './fake-sri';
import { appClient, createApp, makeTenant, ownerClient, randomRuc, seedPermissions, tokenFor, uniqueEmail } from './helpers';

describe('Notas de crédito y compras', () => {
  let owner: PrismaClient;
  let db: PrismaClient;
  let app: INestApplication;
  let T: ProvisionTenantResult;
  let tenantRuc: string;
  let token: string;
  let product: { id: string; taxRateId: string; unitId: string };
  let sessionId: string;
  const sri = new FakeSri();
  const http = () => request(app.getHttpServer());
  const auth = (t = token) => ({ authorization: `Bearer ${t}` });
  const tx = <R>(fn: (t: Parameters<Parameters<typeof withContext>[2]>[0]) => Promise<R>) => withContext(db, { tenantId: T.tenantId }, fn);

  const stockOf = async (productId: string) =>
    (await tx((t) => t.stock.findFirst({ where: { productId, warehouseId: T.warehouseId } })))?.quantity.toString() ?? '0';

  async function sell(buyer: object, quantity: string, discount = '0', payments?: object[]) {
    const total = computeInvoice([{ description: 'x', quantity, unitPrice: '10', discount, taxes: [{ taxCode: '2', percentageCode: '4', rate: '15' }] }]).totals.total;
    const res = await http()
      .post('/api/einvoice/invoices')
      .set(auth())
      .send({
        emissionPointId: T.emissionPointId,
        cashSessionId: sessionId,
        buyer,
        lines: [{ productId: product.id, description: 'Taladro', quantity, unitPrice: '10', discount, taxRateId: product.taxRateId }],
        payments: payments ?? [{ sriCode: '01', method: 'efectivo', amount: total }],
      })
      .expect(201);
    return res.body as { documentId: string; number: string; accessKey: string; total: string };
  }

  beforeAll(async () => {
    owner = ownerClient();
    db = appClient();
    await seedPermissions(owner);
    await seedSriConfig(owner);
    await sri.start();
    await owner.sriSetting.update({ where: { key: 'ws.test' }, data: { value: { reception: sri.receptionUrl, authorization: sri.authorizationUrl } } });
    await owner.sriSetting.update({ where: { key: 'authorization.wait_seconds' }, data: { value: 0 } });
    invalidateSriSettings();
    const email = uniqueEmail('devoluciones');
    tenantRuc = randomRuc();
    T = await makeTenant(owner, tenantRuc, email, 'hardware');
    app = await createApp({ REDIS_URL: 'redis://127.0.0.1:6390/5' });
    token = await tokenFor(app, email);
    await http().post('/api/einvoice/certificate').set(auth()).attach('file', createTestP12('k123'), 'f.p12').field('password', 'k123').expect(200);
    const lk = (await http().get('/api/catalog/lookups').set(auth())).body;
    const iva15 = lk.taxRates.find((r: { percentageCode: string }) => r.percentageCode === '4').id;
    const und = lk.units.find((u: { code: string }) => u.code === 'UND').id;
    const pub = lk.priceLists.find((l: { code: string }) => l.code === 'PUBLICO').id;
    const created = await http()
      .post('/api/products')
      .set(auth())
      .send({ code: 'TAL', name: 'Taladro', unitId: und, taxRateId: iva15, barcodes: ['7861000000017'], prices: [{ priceListId: pub, unitId: und, price: '10' }] })
      .expect(201);
    product = { id: created.body.id, taxRateId: iva15, unitId: und };
    await http().post('/api/inventory/adjustments').set(auth()).send({ warehouseId: T.warehouseId, direction: 'IN', reason: 'Saldo inicial', items: [{ productId: product.id, quantity: '20', unitCost: '6' }] }).expect(201);
    sessionId = (await http().post('/api/cash/sessions').set(auth()).send({ emissionPointId: T.emissionPointId, openingAmount: '100' }).expect(201)).body.id;
  });

  afterAll(async () => {
    await app.close();
    await sri.stop();
    await db.$disconnect();
    await owner.$disconnect();
  });

  // ───────── Notas de crédito ─────────

  let inv: { documentId: string; number: string; accessKey: string; total: string };
  let lineId: string;

  it('busca la factura por número o clave de acceso y muestra lo que se puede devolver', async () => {
    inv = await sell({ idType: '05', id: '1710034065', name: 'Cliente Devolución', email: 'cliente@example.com' }, '3', '1.00');
    expect((await http().get('/api/einvoice/invoices/find').query({ q: inv.number.replace(/-0+/, '-') }).set(auth()).expect(200)).body.id).toBe(inv.documentId);
    expect((await http().get('/api/einvoice/invoices/find').query({ q: inv.accessKey }).set(auth()).expect(200)).body.id).toBe(inv.documentId);
    const c = (await http().get(`/api/einvoice/documents/${inv.documentId}/creditable`).set(auth()).expect(200)).body;
    expect(c.lines).toHaveLength(1);
    expect(c.lines[0]).toMatchObject({ quantity: '3', credited: '0', remaining: '3', discount: '1.00' });
    lineId = c.lines[0].id;
    expect(await stockOf(product.id)).toBe('17');
  });

  let nc1: { documentId: string; number: string; total: string };

  it('devolución parcial con reembolso en efectivo: NC válida, stock vuelve al costo de la venta, egreso de caja', async () => {
    const res = await http()
      .post('/api/einvoice/credit-notes')
      .set(auth())
      .send({ invoiceId: inv.documentId, emissionPointId: T.emissionPointId, reason: 'Devolución de mercadería', lines: [{ sourceLineId: lineId, quantity: '1' }], refund: { method: 'efectivo', cashSessionId: sessionId } })
      .expect(201);
    nc1 = res.body;
    // (1 × 10 − 0,33) × 1,15 = 11,12
    expect(nc1).toMatchObject({ number: '001-001-000000001', total: '11.12' });
    expect(await stockOf(product.id)).toBe('18');

    const edoc = await tx((t) => t.electronicDocument.findUniqueOrThrow({ where: { documentId: nc1.documentId } }));
    expect(edoc).toMatchObject({ docType: '04', status: 'SIGNED' });
    expect(edoc.accessKey.slice(8, 10)).toBe('04');
    const parsed = parseCreditNoteXml(edoc.signedXml as string);
    expect(parsed.modified).toMatchObject({ docType: '01', number: inv.number });
    expect(parsed.buyer.id).toBe('1710034065');
    const unsigned = (edoc.signedXml as string).replace(/<ds:Signature[\s\S]*<\/ds:Signature>/, '');
    expect((await validateAgainstXsd(unsigned, 'notaCredito', '1.1.0')).valid).toBe(true);

    const mv = await tx((t) => t.inventoryMovement.findFirst({ where: { documentId: nc1.documentId } }));
    expect(mv).toMatchObject({ type: 'SALE_RETURN' });
    expect(mv?.unitCost.toString()).toBe('6');

    const cash = await http().get(`/api/cash/sessions/${sessionId}`).set(auth()).expect(200);
    expect(cash.body.cash.out).toBe('11.12');
    expect(cash.body.movements[0].reason).toMatch(/Devolución NC 001-001-000000001/);

    // El SRI la autoriza y el RIDE sale como "nota de crédito"
    await sendStep({ prisma: db }, T.tenantId, nc1.documentId);
    await authorizeStep({ prisma: db }, T.tenantId, nc1.documentId);
    const ride = await http().get(`/api/einvoice/documents/${nc1.documentId}/ride`).set(auth()).expect(200);
    expect(ride.headers['content-type']).toContain('application/pdf');
    const detail = (await http().get(`/api/einvoice/documents/${inv.documentId}`).set(auth()).expect(200)).body;
    expect(detail.creditNotes).toEqual([expect.objectContaining({ number: nc1.number, total: '11.12', status: 'AUTHORIZED' })]);
  });

  it('no deja devolver más de lo que queda; la suma de las notas nunca supera la factura', async () => {
    const over = await http()
      .post('/api/einvoice/credit-notes')
      .set(auth())
      .send({ invoiceId: inv.documentId, emissionPointId: T.emissionPointId, reason: 'Exceso', lines: [{ sourceLineId: lineId, quantity: '3' }], refund: { method: 'transferencia' } })
      .expect(422);
    expect(over.body.message).toMatch(/solo se pueden devolver 2/);
    const rest = await http()
      .post('/api/einvoice/credit-notes')
      .set(auth())
      .send({ invoiceId: inv.documentId, emissionPointId: T.emissionPointId, reason: 'Producto defectuoso', lines: [{ sourceLineId: lineId, quantity: '2', restock: false }], refund: { method: 'transferencia' } })
      .expect(201);
    expect((Number(nc1.total) + Number(rest.body.total)).toFixed(2)).toBe(inv.total);
    // Producto dañado: no vuelve al stock
    expect(await stockOf(product.id)).toBe('18');
    const c = (await http().get(`/api/einvoice/documents/${inv.documentId}/creditable`).set(auth()).expect(200)).body;
    expect(c.lines[0].remaining).toBe('0');
    expect(c.credited).toBe(inv.total);
  });

  it('venta a consumidor final: la nota de crédito exige identificar al cliente (Ficha, Tabla 6)', async () => {
    const cf = await sell({ idType: '07', id: '9999999999999', name: 'CONSUMIDOR FINAL' }, '1');
    const line = (await http().get(`/api/einvoice/documents/${cf.documentId}/creditable`).set(auth())).body.lines[0].id;
    const body = { invoiceId: cf.documentId, emissionPointId: T.emissionPointId, reason: 'Devolución', lines: [{ sourceLineId: line, quantity: '1' }], refund: { method: 'efectivo', cashSessionId: sessionId } };
    const r = await http().post('/api/einvoice/credit-notes').set(auth()).send(body).expect(422);
    expect(r.body.message).toMatch(/cédula o RUC/);
    await http().post('/api/einvoice/credit-notes').set(auth()).send({ ...body, buyer: { idType: '07', id: '9999999999999', name: 'X' } }).expect(400);
    const ok = await http().post('/api/einvoice/credit-notes').set(auth()).send({ ...body, buyer: { idType: '05', id: '1710034065', name: 'Cliente identificado' } }).expect(201);
    const doc = await tx((t) => t.document.findUniqueOrThrow({ where: { id: ok.body.documentId } }));
    expect(doc).toMatchObject({ buyerIdType: '05', buyerId: '1710034065', relatedDocumentId: cf.documentId });
  });

  it('un cajero sin permiso de devoluciones no puede emitir notas de crédito', async () => {
    const roles = (await http().get('/api/roles').set(auth())).body;
    const cashierRole = roles.find((r: { systemCode: string }) => r.systemCode === 'CASHIER');
    const email = uniqueEmail('cajero-nc');
    await http().post('/api/users').set(auth()).send({ email, fullName: 'Cajero', password: 'Cajero.2026', roleIds: [cashierRole.id] }).expect(201);
    const t = (await http().post('/api/auth/login').send({ email, password: 'Cajero.2026' })).body.accessToken;
    await http().get(`/api/einvoice/documents/${inv.documentId}/creditable`).set(auth(t)).expect(403);
  });

  // ───────── Compras ─────────

  const supplierRuc = randomRuc();

  it('compra manual con proveedor nuevo: suma stock y recalcula el costo promedio', async () => {
    // Stock 18 a costo 6 → compra 12 a 8,50 con $6 de descuento → costo neto (102−6)/12 = 8 → (18×6 + 12×8)/30 = 6,80
    const res = await http()
      .post('/api/purchases')
      .set(auth())
      .send({
        newSupplier: { idType: '04', identification: supplierRuc, name: 'DISTRIBUIDORA PROVEEDORA S.A.' },
        docType: '01',
        number: '001-002-000004567',
        authorization: '1'.repeat(49),
        issueDate: '2026-11-15',
        warehouseId: T.warehouseId,
        lines: [{ productId: product.id, description: 'Taladro', quantity: '12', unitCost: '8.50', discount: '6.00', taxRateId: product.taxRateId }],
      })
      .expect(201);
    expect(await stockOf(product.id)).toBe('30');
    const p = await tx((t) => t.product.findUniqueOrThrow({ where: { id: product.id } }));
    expect(p.avgCost.toString()).toBe('6.8');
    const detail = (await http().get(`/api/purchases/${res.body.id}`).set(auth()).expect(200)).body;
    expect(detail).toMatchObject({ subtotal: '96.00', totalTax: '14.40', total: '110.40', status: 'REGISTERED', supplierName: 'DISTRIBUIDORA PROVEEDORA S.A.' });
    const supplier = await tx((t) => t.party.findFirst({ where: { identification: supplierRuc } }));
    expect(supplier).toMatchObject({ isSupplier: true, isCustomer: false });
    // La misma factura del proveedor no se registra dos veces
    await http()
      .post('/api/purchases')
      .set(auth())
      .send({ supplierId: supplier?.id, number: '001-002-000004567', issueDate: '2026-11-15', warehouseId: T.warehouseId, lines: [{ description: 'x', quantity: '1', unitCost: '1', taxRateId: product.taxRateId }] })
      .expect(409);
  });

  function supplierXml(seq: number, code: string): string {
    const computed = computeInvoice([
      { mainCode: code, description: 'TALADRO PERCUTOR 1/2', quantity: '5', unitPrice: '9.000000', discount: '0', taxes: [{ taxCode: '2', percentageCode: '4', rate: '15' }] },
      { mainCode: 'FLETE', description: 'Transporte', quantity: '1', unitPrice: '3.000000', discount: '0', taxes: [{ taxCode: '2', percentageCode: '4', rate: '15' }] },
    ]);
    return buildInvoiceXml({
      version: '1.1.0',
      environment: 1,
      accessKey: buildAccessKey({ issueDate: { day: 14, month: 11, year: 2026 }, docType: '01', ruc: supplierRuc, environment: 1, establishment: '001', emissionPoint: '002', sequential: seq }),
      establishment: '001',
      emissionPoint: '002',
      sequential: String(seq),
      issueDate: { day: 14, month: 11, year: 2026 },
      issuer: { ruc: supplierRuc, legalName: 'DISTRIBUIDORA PROVEEDORA S.A.', mainAddress: 'Guayaquil', keepsAccounting: true },
      buyer: { idType: '04', id: tenantRuc, name: 'MI EMPRESA' },
      lines: computed.lines,
      totals: computed.totals,
      payments: [{ code: '20', amount: computed.totals.total }],
      additionalInfo: [],
      currency: 'DOLAR',
    });
  }

  it('XML del proveedor: propone las líneas, relaciona productos por código y recuerda el código del proveedor', async () => {
    const preview = (await http().post('/api/purchases/xml-preview').set(auth()).attach('file', Buffer.from(supplierXml(4600, 'TAL')), 'factura.xml').expect(200)).body;
    expect(preview).toMatchObject({ number: '001-002-000004600', issueDate: '2026-11-14', duplicate: false, buyerMismatch: null, totals: { total: '55.20' } });
    expect(preview.supplier.id).not.toBeNull();
    expect(preview.lines[0].match).toMatchObject({ productId: product.id, by: 'code' });
    expect(preview.lines[1].match).toBeNull();

    await http()
      .post('/api/purchases')
      .set(auth())
      .send({
        supplierId: preview.supplier.id,
        number: preview.number,
        authorization: preview.authorization,
        issueDate: preview.issueDate,
        warehouseId: T.warehouseId,
        fromXml: true,
        lines: preview.lines.map((l: { match: { productId: string } | null; supplierCode: string; description: string; quantity: string; unitCost: string; discount: string; taxRateId: string }) => ({
          productId: l.match?.productId ?? null,
          supplierCode: l.supplierCode,
          description: l.description,
          quantity: l.quantity,
          unitCost: l.unitCost,
          discount: l.discount,
          taxRateId: l.taxRateId,
        })),
      })
      .expect(201);
    expect(await stockOf(product.id)).toBe('35');

    // Otro XML del mismo proveedor con un código distinto que ya se enseñó: ahora se reconoce
    await tx((t) => t.supplierProductCode.create({ data: { tenantId: T.tenantId, supplierId: preview.supplier.id, supplierCode: 'TAL-PROV-99', productId: product.id } }));
    const p2 = (await http().post('/api/purchases/xml-preview').set(auth()).attach('file', Buffer.from(supplierXml(4601, 'TAL-PROV-99')), 'f2.xml').expect(200)).body;
    expect(p2.lines[0].match).toMatchObject({ productId: product.id, by: 'remembered' });
    // El mismo XML ya registrado se marca como duplicado
    const again = (await http().post('/api/purchases/xml-preview').set(auth()).attach('file', Buffer.from(supplierXml(4600, 'TAL')), 'f.xml').expect(200)).body;
    expect(again.duplicate).toBe(true);
  });

  it('anular una compra descuenta del stock lo que entró', async () => {
    const list = (await http().get('/api/purchases').set(auth()).expect(200)).body;
    const last = list.items.find((i: { number: string }) => i.number === '001-002-000004600');
    await http().post(`/api/purchases/${last.id}/void`).set(auth()).send({ reason: 'Error de digitación' }).expect(204);
    expect(await stockOf(product.id)).toBe('30');
    const d = (await http().get(`/api/purchases/${last.id}`).set(auth()).expect(200)).body;
    expect(d).toMatchObject({ status: 'VOID', voidReason: 'Error de digitación' });
    await http().post(`/api/purchases/${last.id}/void`).set(auth()).send({ reason: 'otra vez' }).expect(422);
  });
});
