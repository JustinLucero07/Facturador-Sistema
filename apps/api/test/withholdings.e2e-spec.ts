/**
 * Fase 6: comprobantes de retención a proveedores (XML ATS v2.0.0) y catálogo de códigos.
 */
import type { INestApplication } from '@nestjs/common';
import { PrismaClient, ProvisionTenantResult, seedSriConfig, withContext } from '@vektra/db';
import { authorizeStep, invalidateSriSettings, sendStep } from '@vektra/einvoice';
import { parseWithholdingXml, validateAgainstXsd } from '@vektra/sri-core';
import { createTestP12 } from '@vektra/sri-core/testing';
import request from 'supertest';
import { FakeSri } from './fake-sri';
import { appClient, createApp, makeTenant, ownerClient, randomRuc, seedPermissions, tokenFor, uniqueEmail } from './helpers';

describe('Comprobantes de retención', () => {
  let owner: PrismaClient;
  let db: PrismaClient;
  let app: INestApplication;
  let T: ProvisionTenantResult;
  let token: string;
  let purchaseId: string;
  let codes: { id: string; tax: string; code: string; percentage: string | null }[];
  const sri = new FakeSri();
  const supplierRuc = randomRuc();
  const http = () => request(app.getHttpServer());
  const auth = () => ({ authorization: `Bearer ${token}` });
  const code = (tax: string, c: string) => codes.find((x) => x.tax === tax && x.code === c)!;

  beforeAll(async () => {
    owner = ownerClient();
    db = appClient();
    await seedPermissions(owner);
    await seedSriConfig(owner);
    await sri.start();
    await owner.sriSetting.update({ where: { key: 'ws.test' }, data: { value: { reception: sri.receptionUrl, authorization: sri.authorizationUrl } } });
    await owner.sriSetting.update({ where: { key: 'authorization.wait_seconds' }, data: { value: 0 } });
    invalidateSriSettings();
    const email = uniqueEmail('retenciones');
    T = await makeTenant(owner, randomRuc(), email, 'hardware');
    app = await createApp({ REDIS_URL: 'redis://127.0.0.1:6390/5' });
    token = await tokenFor(app, email);
    await http().post('/api/einvoice/certificate').set(auth()).attach('file', createTestP12('k123'), 'f.p12').field('password', 'k123').expect(200);
    const lk = (await http().get('/api/catalog/lookups').set(auth())).body;
    const iva15 = lk.taxRates.find((r: { percentageCode: string }) => r.percentageCode === '4').id;
    const res = await http()
      .post('/api/purchases')
      .set(auth())
      .send({
        newSupplier: { idType: '04', identification: supplierRuc, name: 'SERVICIOS Y SUMINISTROS S.A.', email: 'facturas@proveedor.example' },
        number: '002-001-000000777',
        authorization: '1'.repeat(49),
        issueDate: '2026-11-16',
        warehouseId: T.warehouseId,
        lines: [{ description: 'Mantenimiento de equipos', quantity: '1', unitCost: '1000', taxRateId: iva15 }],
      })
      .expect(201);
    purchaseId = res.body.id;
    codes = (await http().get('/api/tax/withholding-codes').set(auth()).expect(200)).body;
  });

  afterAll(async () => {
    await app.close();
    await sri.stop();
    await db.$disconnect();
    await owner.$disconnect();
  });

  it('el catálogo trae los códigos oficiales: renta (Catálogo ATS) e IVA (Ficha, Tabla 20)', () => {
    expect(code('1', '312')).toMatchObject({ percentage: '2' });
    expect(code('1', '303')).toMatchObject({ percentage: '10' });
    expect(code('1', '312C')).toMatchObject({ percentage: '1.75' });
    expect(code('1', '327')).toMatchObject({ percentage: null }); // "12 o 14": variable
    expect(code('2', '1')).toMatchObject({ percentage: '30' });
    expect(code('2', '2')).toMatchObject({ percentage: '70' });
    expect(code('2', '3')).toMatchObject({ percentage: '100' });
  });

  it('el borrador muestra las bases de la compra (subtotal e IVA)', async () => {
    const d = (await http().get(`/api/einvoice/purchases/${purchaseId}/withholding-draft`).set(auth()).expect(200)).body;
    expect(d.purchase).toMatchObject({ number: '002-001-000000777', subtotal: '1000.00', iva: '150.00', total: '1150.00' });
    expect(d.previous).toBeNull();
    expect(d.sustento.map((s: { code: string }) => s.code)).toContain('02');
  });

  it('valida porcentajes y bases contra la compra', async () => {
    const base = { purchaseId, emissionPointId: T.emissionPointId, sustentoCode: '02', paymentCode: '20' };
    const r1 = await http().post('/api/einvoice/withholdings').set(auth()).send({ ...base, items: [{ withholdingCodeId: code('1', '312').id, base: '1000.01' }] }).expect(422);
    expect(r1.body.message).toMatch(/no puede superar el subtotal/);
    const r2 = await http().post('/api/einvoice/withholdings').set(auth()).send({ ...base, items: [{ withholdingCodeId: code('2', '2').id, base: '151' }] }).expect(422);
    expect(r2.body.message).toMatch(/no puede superar el IVA/);
    const r3 = await http().post('/api/einvoice/withholdings').set(auth()).send({ ...base, items: [{ withholdingCodeId: code('1', '312').id, base: '1000', percentage: '1' }] }).expect(422);
    expect(r3.body.message).toMatch(/retiene el 2%/);
    const r4 = await http().post('/api/einvoice/withholdings').set(auth()).send({ ...base, items: [{ withholdingCodeId: code('1', '327').id, base: '1000' }] }).expect(422);
    expect(r4.body.message).toMatch(/porcentaje variable/);
  });

  let docId: string;

  it('emite la retención: XML v2.0.0 válido, valores correctos, el SRI la autoriza y sale el RIDE', async () => {
    const res = await http()
      .post('/api/einvoice/withholdings')
      .set(auth())
      .send({
        purchaseId,
        emissionPointId: T.emissionPointId,
        sustentoCode: '02',
        paymentCode: '20',
        items: [
          { withholdingCodeId: code('1', '307').id, base: '1000' }, // mano de obra 3 %
          { withholdingCodeId: code('2', '2').id, base: '150' }, // IVA 70 %
        ],
      })
      .expect(201);
    expect(res.body).toMatchObject({ number: '001-001-000000001', total: '135.00' }); // 30 + 105
    docId = res.body.documentId;

    const edoc = await withContext(db, { tenantId: T.tenantId }, (tx) => tx.electronicDocument.findUniqueOrThrow({ where: { documentId: docId } }));
    expect(edoc).toMatchObject({ docType: '07', xmlVersion: '2.0.0', status: 'SIGNED', emailStatus: 'PENDING' });
    const unsigned = (edoc.signedXml as string).replace(/<ds:Signature[\s\S]*<\/ds:Signature>/, '');
    expect((await validateAgainstXsd(unsigned, 'comprobanteRetencion', '2.0.0')).errors).toEqual([]);
    const w = parseWithholdingXml(edoc.signedXml as string);
    expect(w.subject).toMatchObject({ idType: '04', id: supplierRuc });
    expect(w.support).toMatchObject({ sustentoCode: '02', docType: '01', number: '002-001-000000777', subtotal: '1000.00', total: '1150.00' });
    expect(w.items).toEqual([
      { tax: '1', code: '307', base: '1000.00', percentage: '3', amount: '30.00' },
      { tax: '2', code: '2', base: '150.00', percentage: '70', amount: '105.00' },
    ]);

    await sendStep({ prisma: db }, T.tenantId, docId);
    await authorizeStep({ prisma: db }, T.tenantId, docId);
    const ride = await http().get(`/api/einvoice/documents/${docId}/ride`).set(auth()).expect(200);
    expect(ride.headers['content-type']).toContain('application/pdf');
    const detail = (await http().get(`/api/einvoice/documents/${docId}`).set(auth()).expect(200)).body;
    expect(detail).toMatchObject({ docType: '07', status: 'AUTHORIZED', purchase: { id: purchaseId } });
    expect(detail.withholdings).toHaveLength(2);
  });

  it('una compra no puede tener dos retenciones vigentes; la siguiente compra sugiere lo último usado', async () => {
    await http()
      .post('/api/einvoice/withholdings')
      .set(auth())
      .send({ purchaseId, emissionPointId: T.emissionPointId, sustentoCode: '02', paymentCode: '20', items: [{ withholdingCodeId: code('1', '307').id, base: '1' }] })
      .expect(422);
    const d = (await http().get(`/api/einvoice/purchases/${purchaseId}/withholding-draft`).set(auth()).expect(200)).body;
    expect(d.existing).toEqual([expect.objectContaining({ number: '001-001-000000001', status: 'AUTHORIZED' })]);
    expect(d.previous).toMatchObject({ sustentoCode: '02', paymentCode: '20' });
    expect(d.previous.items.map((i: { withholdingCodeId: string }) => i.withholdingCodeId)).toEqual([code('1', '307').id, code('2', '2').id]);
  });

  it('el catálogo se edita (cambios de porcentaje por resolución) sin tocar código', async () => {
    const c = code('1', '312');
    await http()
      .patch(`/api/tax/withholding-codes/${c.id}`)
      .set(auth())
      .send({ tax: '1', code: '312', description: 'Transferencia de bienes muebles de naturaleza corporal', percentage: '2.5', validFrom: '2026-08-06', active: true })
      .expect(204);
    const after = (await http().get('/api/tax/withholding-codes').set(auth())).body.find((x: { id: string }) => x.id === c.id);
    expect(after.percentage).toBe('2.5');
    // Restaurar (la tabla es global en la instalación de pruebas)
    await http().patch(`/api/tax/withholding-codes/${c.id}`).set(auth()).send({ tax: '1', code: '312', description: after.description, percentage: '2', validFrom: '2026-08-06', active: true }).expect(204);
  });
});
