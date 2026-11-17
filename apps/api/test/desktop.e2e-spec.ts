/**
 * Fase 4: caja de escritorio sin conexión.
 * El motor local real (@vektra/pos-local, SQLite) habla con la API real por HTTP. El "corte de red"
 * se simula apuntando la caja a un puerto cerrado; luego se reconecta y se sincroniza.
 */
import type { INestApplication } from '@nestjs/common';
import { PrismaClient, ProvisionTenantResult, seedSriConfig, uuidv7, withContext } from '@vektra/db';
import { authorizeStep, invalidateSriSettings, sendStep } from '@vektra/einvoice';
import { createLocalEngine, type DeviceLink, type LocalEngine } from '@vektra/pos-local';
import { createTestP12 } from '@vektra/sri-core/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { FakeSri } from './fake-sri';
import { appClient, createApp, makeTenant, ownerClient, PASSWORD, randomRuc, seedPermissions, tokenFor, uniqueEmail } from './helpers';

describe('Caja de escritorio (sin conexión y sincronización)', () => {
  let owner: PrismaClient;
  let db: PrismaClient;
  let app: INestApplication;
  let T: ProvisionTenantResult;
  let token: string;
  let adminEmail: string;
  let serverUrl: string;
  let desktopEp: string;
  let deviceId: string;
  let engine: LocalEngine;
  let localUrl: string;
  let localToken: string;
  let sessionId: string;
  let product: { id: string; taxRateId: string; unitId: string };
  let clock = new Date();
  const dir = mkdtempSync(join(tmpdir(), 'vk-desktop-'));
  const sri = new FakeSri();
  const http = () => request(app.getHttpServer());
  const auth = () => ({ authorization: `Bearer ${token}` });

  /** Llamada a la API local de la caja (como lo hace la pantalla del POS). */
  async function local<T = any>(method: string, path: string, body?: unknown, tk = localToken): Promise<{ status: number; body: T }> {
    const res = await fetch(`${localUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  const sale = (lines: object[], payments: object[], buyer: object = { idType: '07', id: '9999999999999', name: 'CONSUMIDOR FINAL' }) => ({
    emissionPointId: desktopEp,
    cashSessionId: sessionId,
    buyer,
    lines,
    payments,
  });

  const setServer = (url: string) => {
    const link = engine.ctx.link as DeviceLink;
    engine.db.setMeta('device', { ...link, serverUrl: url });
  };

  beforeAll(async () => {
    owner = ownerClient();
    db = appClient();
    await seedPermissions(owner);
    await seedSriConfig(owner);
    await sri.start();
    await owner.sriSetting.update({ where: { key: 'ws.test' }, data: { value: { reception: sri.receptionUrl, authorization: sri.authorizationUrl } } });
    await owner.sriSetting.update({ where: { key: 'authorization.wait_seconds' }, data: { value: 0 } });
    invalidateSriSettings();
    adminEmail = uniqueEmail('escritorio');
    T = await makeTenant(owner, randomRuc(), adminEmail, 'hardware');
    app = await createApp({ REDIS_URL: 'redis://127.0.0.1:6390/5' });
    await app.listen(0, '127.0.0.1');
    serverUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    token = await tokenFor(app, adminEmail);
    await http().post('/api/einvoice/certificate').set(auth()).attach('file', createTestP12('k123'), 'f.p12').field('password', 'k123').expect(200);

    // Punto de emisión 002 de tipo "caja de escritorio"
    desktopEp = uuidv7();
    await owner.emissionPoint.create({ data: { id: desktopEp, tenantId: T.tenantId, establishmentId: T.establishmentId, code: '002', name: 'Caja escritorio', kind: 'DESKTOP' } });

    const lk = (await http().get('/api/catalog/lookups').set(auth())).body;
    const iva15 = lk.taxRates.find((r: { percentageCode: string }) => r.percentageCode === '4').id;
    const und = lk.units.find((u: { code: string }) => u.code === 'UND').id;
    const pub = lk.priceLists.find((l: { code: string }) => l.code === 'PUBLICO').id;
    const created = await http()
      .post('/api/products')
      .set(auth())
      .send({ code: 'TAL-1', name: 'Taladro percutor', unitId: und, taxRateId: iva15, barcodes: ['7861234500011'], prices: [{ priceListId: pub, unitId: und, price: '40' }] })
      .expect(201);
    product = { id: created.body.id, taxRateId: iva15, unitId: und };
    // Stock inicial en la bodega del establecimiento
    await http().post('/api/inventory/adjustments').set(auth()).send({ warehouseId: T.warehouseId, direction: 'IN', reason: 'Saldo inicial', items: [{ productId: product.id, quantity: '10', unitCost: '25' }] }).expect(201);

    engine = createLocalEngine({ dbPath: join(dir, 'caja.sqlite'), webRoot: null, appVersion: 'test', fingerprint: 'equipo-de-prueba-01', syncIntervalMs: 3_600_000, now: () => clock });
    localUrl = `http://127.0.0.1:${await engine.start(0)}`;
  });

  afterAll(async () => {
    await engine?.stop();
    rmSync(dir, { recursive: true, force: true });
    await app.close();
    await sri.stop();
    await db.$disconnect();
    await owner.$disconnect();
  });

  it('la web crea la caja y entrega un código de vinculación de un solo uso', async () => {
    // Un punto WEB no puede ser caja de escritorio
    await http().post('/api/devices').set(auth()).send({ emissionPointId: T.emissionPointId, name: 'Caja 2' }).expect(422);
    const res = await http().post('/api/devices').set(auth()).send({ emissionPointId: desktopEp, name: 'Caja mostrador' }).expect(201);
    expect(res.body.code).toMatch(/^[A-Z2-9]{10}$/);
    expect(res.body.device).toMatchObject({ status: 'pending', name: 'Caja mostrador' });
    deviceId = res.body.device.id;

    // La caja sin vincular no deja vender
    const rt = await local('GET', '/api/runtime');
    expect(rt.body).toMatchObject({ mode: 'desktop', paired: false });
    expect((await local('POST', '/api/auth/login', { email: adminEmail, password: PASSWORD })).status).toBe(503);

    // Código inválido
    expect((await local('POST', '/api/desktop/pair', { serverUrl, code: 'AAAAAAAAAA' })).status).toBe(401);
    // Vinculación + primera sincronización completa
    const paired = await local('POST', '/api/desktop/pair', { serverUrl, code: res.body.code });
    expect(paired.status).toBe(200);
    expect(paired.body).toMatchObject({ paired: true, online: true, deviceName: 'Caja mostrador' });
    // El código ya no sirve
    await http().post('/api/devices/pair').send({ code: res.body.code, fingerprint: 'otra-pc-000', appVersion: 'x' }).expect(401);
  });

  it('el cajero entra con su clave de siempre (verificada en la caja) y ve el catálogo local', async () => {
    expect((await local('POST', '/api/auth/login', { email: adminEmail, password: 'mala' })).status).toBe(401);
    const login = await local('POST', '/api/auth/login', { email: adminEmail, password: PASSWORD });
    expect(login.status).toBe(200);
    localToken = login.body.accessToken;
    const found = await local('GET', '/api/products/search?q=7861234500011');
    expect(found.body[0]).toMatchObject({ code: 'TAL-1', stock: '10', units: [{ price: '40' }] });
    const cfg = await local('GET', '/api/einvoice/config');
    expect(cfg.body.emissionPoints).toHaveLength(1);
    expect(cfg.body.emissionPoints[0].id).toBe(desktopEp);
    expect(cfg.body.certificate.present).toBe(true);
  });

  let onlineDoc: { documentId: string; accessKey: string; number: string };

  it('venta en línea: se guarda local y llega al servidor con la misma clave de acceso', async () => {
    const open = await local('POST', '/api/cash/sessions', { emissionPointId: desktopEp, openingAmount: '50' });
    expect(open.status).toBe(200);
    sessionId = open.body.id;
    const res = await local('POST', '/api/einvoice/invoices', sale([{ productId: product.id, description: 'Taladro percutor', quantity: '1', unitPrice: '40', taxRateId: product.taxRateId }], [{ sriCode: '01', method: 'efectivo', amount: '46.00', cashReceived: '50' }]));
    expect(res.status).toBe(200);
    expect(res.body.number).toBe('001-002-000000001');
    onlineDoc = res.body;
    const ticket = await local('GET', `/api/pos/tickets/${res.body.documentId}`);
    expect(ticket.body).toMatchObject({ total: '46.00', status: 'PENDING_SYNC', payments: [{ change: '4.00' }] });

    await engine.sync.run();
    const docs = await withContext(db, { tenantId: T.tenantId }, (tx) => tx.document.findMany({ where: { emissionPointId: desktopEp }, include: { electronic: true } }));
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ id: res.body.documentId, deviceId, sequential: 1n });
    expect(docs[0].electronic?.accessKey).toBe(res.body.accessKey);
    expect(docs[0].electronic?.status).toBe('SIGNED');
    // El enlace QR del ticket (firmado por la caja) abre el RIDE en el servidor
    const path = new URL(ticket.body.publicRideUrl).pathname;
    const ride = await http().get(path).expect(200);
    expect(ride.headers['content-type']).toContain('application/pdf');
  });

  it('la web no puede facturar en el punto de la caja de escritorio', async () => {
    const res = await http()
      .post('/api/einvoice/invoices')
      .set(auth())
      .send({ emissionPointId: desktopEp, buyer: { idType: '07', id: '9999999999999', name: 'CONSUMIDOR FINAL' }, lines: [{ description: 'X', quantity: '1', unitPrice: '1', taxRateId: product.taxRateId }], payments: [{ sriCode: '01', method: 'efectivo', amount: '1.15' }] })
      .expect(422);
    expect(res.body.message).toMatch(/caja de escritorio/);
  });

  it('SIN INTERNET: la caja sigue vendiendo, crea clientes y productos, y numera sin saltos', async () => {
    setServer('http://127.0.0.1:1'); // corte de red
    clock = new Date(Date.now() + 2 * 3600_000);
    await engine.sync.run().catch(() => undefined);
    expect((await local('GET', '/api/runtime')).body).toMatchObject({ online: false });

    // Cliente nuevo
    const party = await local('POST', '/api/parties', { idType: '05', identification: '1710034065', name: 'Cliente Sin Internet', email: 'sin.internet@example.com', isCustomer: true });
    expect(party.status).toBe(200);
    // Producto nuevo (alta rápida)
    const newProductId = uuidv7();
    const newUnitId = uuidv7();
    const quick = await local('POST', '/api/products/quick', { id: newProductId, productUnitId: newUnitId, code: 'BROCA-6', name: 'Broca 6 mm', unitId: product.unitId, taxRateId: product.taxRateId, barcode: '7860000000006', price: '2.00' });
    expect(quick.status).toBe(200);
    expect((await local('GET', '/api/products/search?q=7860000000006')).body[0]).toMatchObject({ id: newProductId, units: [{ price: '2.00' }] });

    const v2 = await local(
      'POST',
      '/api/einvoice/invoices',
      sale(
        [
          { productId: product.id, description: 'Taladro percutor', quantity: '2', unitPrice: '40', taxRateId: product.taxRateId },
          { productId: newProductId, productUnitId: newUnitId, description: 'Broca 6 mm', quantity: '3', unitPrice: '2', taxRateId: product.taxRateId },
        ],
        [{ sriCode: '19', method: 'tarjeta_credito', amount: '98.90', reference: 'LOTE 77' }],
        { idType: '05', id: '1710034065', name: 'Cliente Sin Internet', email: 'sin.internet@example.com' },
      ),
    );
    expect(v2.status).toBe(200);
    expect(v2.body.number).toBe('001-002-000000002');
    const v3 = await local('POST', '/api/einvoice/invoices', sale([{ productId: product.id, description: 'Taladro percutor', quantity: '1', unitPrice: '40', taxRateId: product.taxRateId }], [{ sriCode: '01', method: 'efectivo', amount: '46.00' }]));
    expect(v3.body.number).toBe('001-002-000000003');
    // Stock local: 10 - 1 (ya sincronizada) - 2 - 1 (pendientes) = 6
    expect((await local('GET', '/api/products/search?q=TAL-1')).body[0].stock).toBe('6');
    // Egreso de caja sin conexión
    expect((await local('POST', `/api/cash/sessions/${sessionId}/movements`, { type: 'OUT', amount: '10', reason: 'Pago de flete' })).status).toBe(200);

    const rt = await local('GET', '/api/runtime');
    expect(rt.body.pendingOps).toBe(5); // cliente, producto, 2 facturas, egreso
    // En el servidor todavía no existe nada de esto
    expect(await withContext(db, { tenantId: T.tenantId }, (tx) => tx.document.count({ where: { emissionPointId: desktopEp } }))).toBe(1);
  });

  it('pasado el límite de horas sin sincronizar, la caja deja de facturar', async () => {
    const saved = clock;
    clock = new Date(Date.now() + 49 * 3600_000);
    const res = await local('POST', '/api/einvoice/invoices', sale([{ productId: product.id, description: 'Taladro', quantity: '1', unitPrice: '40', taxRateId: product.taxRateId }], [{ sriCode: '01', method: 'efectivo', amount: '46.00' }]));
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/más de 48 horas/);
    clock = saved;
  });

  it('VUELVE INTERNET: sincroniza todo en orden, con los mismos números y claves, sin duplicados', async () => {
    setServer(serverUrl);
    await engine.sync.run();
    const rt = await local('GET', '/api/runtime');
    expect(rt.body).toMatchObject({ online: true, pendingOps: 0, failedOps: 0 });

    const docs = await withContext(db, { tenantId: T.tenantId }, (tx) =>
      tx.document.findMany({ where: { emissionPointId: desktopEp }, include: { electronic: true, payments: true }, orderBy: { sequential: 'asc' } }),
    );
    expect(docs.map((d) => Number(d.sequential))).toEqual([1, 2, 3]);
    const localDocs = engine.db.all<{ id: string; access_key: string; status: string }>('SELECT id, access_key, status FROM documents ORDER BY sequential');
    expect(docs.map((d) => d.electronic?.accessKey)).toEqual(localDocs.map((d) => d.access_key));
    expect(localDocs.every((d) => d.status === 'SIGNED')).toBe(true);
    // Fecha de emisión = la de la caja (2 h después), no la de sincronización
    expect(docs[1].createdAt.getTime()).toBeLessThanOrEqual(clock.getTime());
    expect(docs[1].payments[0]).toMatchObject({ sriCode: '19', reference: 'LOTE 77' });

    // Cliente y producto creados sin conexión ya existen en el servidor
    const party = await withContext(db, { tenantId: T.tenantId }, (tx) => tx.party.findFirst({ where: { identification: '1710034065' } }));
    expect(party?.name).toBe('Cliente Sin Internet');
    const broca = await withContext(db, { tenantId: T.tenantId }, (tx) => tx.product.findFirst({ where: { code: 'BROCA-6' }, include: { stock: true } }));
    expect(broca).not.toBeNull();
    // Stock del servidor: 10 − 4 = 6 (igual que en la caja); la broca quedó negativa (venta sin stock registrada)
    const st = await withContext(db, { tenantId: T.tenantId }, (tx) => tx.stock.findFirst({ where: { productId: product.id, warehouseId: T.warehouseId } }));
    expect(st?.quantity.toString()).toBe('6');
    expect(broca?.stock[0]?.quantity.toString()).toBe('-3');
    // El contador del servidor quedó después del último secuencial de la caja
    const counter = await withContext(db, { tenantId: T.tenantId }, (tx) => tx.sequenceCounter.findFirst({ where: { emissionPointId: desktopEp, docType: '01' } }));
    expect(Number(counter?.nextValue)).toBe(4);
  });

  it('reenviar las mismas operaciones no duplica nada (idempotencia)', async () => {
    engine.db.run("UPDATE outbox SET status = 'pending'");
    await engine.sync.run();
    const ops = engine.db.all<{ status: string }>('SELECT status FROM outbox');
    expect(ops.every((o) => o.status === 'done')).toBe(true);
    expect(await withContext(db, { tenantId: T.tenantId }, (tx) => tx.document.count({ where: { emissionPointId: desktopEp } }))).toBe(3);
    expect(await withContext(db, { tenantId: T.tenantId }, (tx) => tx.cashMovement.count({ where: { sessionId } }))).toBe(1);
  });

  it('el SRI autoriza y la caja recibe el estado en la siguiente sincronización', async () => {
    const ids = engine.db.all<{ id: string }>('SELECT id FROM documents').map((d) => d.id);
    for (const id of ids) {
      await sendStep({ prisma: db }, T.tenantId, id);
      await authorizeStep({ prisma: db }, T.tenantId, id);
    }
    await engine.sync.run();
    const statuses = engine.db.all<{ status: string; authorization_number: string | null }>('SELECT status, authorization_number FROM documents');
    expect(statuses.every((s) => s.status === 'AUTHORIZED' && !!s.authorization_number)).toBe(true);
    expect((await local('GET', `/api/einvoice/documents/${onlineDoc.documentId}`)).body.status).toBe('AUTHORIZED');
  });

  it('arqueo y cierre en la caja: el servidor recibe el mismo resultado', async () => {
    const summary = await local('GET', `/api/cash/sessions/${sessionId}`);
    // efectivo esperado = 50 + 46 + 46 − 10 = 132
    expect(summary.body.cash).toMatchObject({ opening: '50.00', sales: '92.00', out: '10.00', expected: '132.00' });
    const closed = await local('POST', `/api/cash/sessions/${sessionId}/close`, { counted: { efectivo: '131.50', tarjeta_credito: '98.90' } });
    expect(closed.body).toMatchObject({ status: 'CLOSED', difference: '-0.50' });
    await engine.sync.run();
    const s = await withContext(db, { tenantId: T.tenantId }, (tx) => tx.cashSession.findUnique({ where: { id: sessionId } }));
    expect(s?.status).toBe('CLOSED');
    expect(s?.difference?.toString()).toBe('-0.5');
    // El arqueo del servidor (calculado con sus propios datos) coincide con el de la caja
    const server = await http().get(`/api/cash/sessions/${sessionId}`).set(auth()).expect(200);
    expect(server.body.cash.expected).toBe('132.00');
    expect(server.body.invoices).toBe(3);
  });

  it('DEVOLUCIÓN SIN CONEXIÓN: nota de crédito en la caja, se sincroniza con la misma clave', async () => {
    setServer('http://127.0.0.1:1');
    const docs = engine.db.all<{ id: string; number: string }>('SELECT id, number FROM documents ORDER BY sequential');
    const v2 = docs[1]; // 2 taladros + 3 brocas a "Cliente Sin Internet"
    const found = await local('GET', `/api/einvoice/invoices/find?q=${v2.number}`);
    expect(found.body.id).toBe(v2.id);
    const c = (await local('GET', `/api/einvoice/documents/${v2.id}/creditable`)).body;
    const taladro = c.lines.find((l: { description: string }) => l.description.startsWith('Taladro'));
    const before = (await local('GET', '/api/products/search?q=TAL-1')).body[0].stock;
    const nc = await local('POST', '/api/einvoice/credit-notes', {
      invoiceId: v2.id,
      emissionPointId: desktopEp,
      reason: 'Devolución de mercadería',
      lines: [{ sourceLineId: taladro.id, quantity: '1' }],
      refund: { method: 'transferencia' },
    });
    expect(nc.status).toBe(200);
    expect(nc.body).toMatchObject({ number: '001-002-000000001', total: '46.00' });
    // El taladro vuelve al stock de la caja de inmediato
    expect(Number((await local('GET', '/api/products/search?q=TAL-1')).body[0].stock)).toBe(Number(before) + 1);
    expect((await local('GET', `/api/pos/tickets/${nc.body.documentId}`)).body).toMatchObject({ docLabel: 'NOTA DE CRÉDITO', related: { number: v2.number } });
    // No se puede devolver dos veces lo mismo (aunque siga sin conexión)
    const again = await local('POST', '/api/einvoice/credit-notes', { invoiceId: v2.id, emissionPointId: desktopEp, reason: 'Otra', lines: [{ sourceLineId: taladro.id, quantity: '2' }], refund: { method: 'transferencia' } });
    expect(again.status).toBe(422);

    setServer(serverUrl);
    await engine.sync.run();
    const server = await withContext(db, { tenantId: T.tenantId }, (tx) =>
      tx.document.findUniqueOrThrow({ where: { id: nc.body.documentId }, include: { electronic: true } }),
    );
    expect(server).toMatchObject({ docType: '04', relatedDocumentId: v2.id, deviceId, sequential: 1n });
    expect(server.electronic?.accessKey).toBe(nc.body.accessKey);
    expect(server.total.toString()).toBe('46');
    expect(engine.db.get<{ status: string }>('SELECT status FROM credit_notes WHERE id = ?', nc.body.documentId)?.status).toBe('SIGNED');
  });

  it('el panel de la web muestra la caja; al revocarla deja de sincronizar', async () => {
    const list = await http().get('/api/devices').set(auth()).expect(200);
    expect(list.body[0]).toMatchObject({ id: deviceId, status: 'active', pendingOps: 0, failedOps: 0, appVersion: 'test' });
    expect(list.body[0].lastSyncAt).not.toBeNull();
    await http().post(`/api/devices/${deviceId}/revoke`).set(auth()).expect(200);
    await expect(engine.sync.run()).rejects.toThrow(/revocada|vinculada/);
    expect(engine.sync.state.revoked).toBe(true);
  });
});
