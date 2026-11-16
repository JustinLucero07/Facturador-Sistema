/**
 * Fase 2: productos, clientes/proveedores, inventario (kárdex con costo promedio) e importación Excel.
 * Criterio de aceptación: importar 2.000 productos desde Excel con errores reportados fila por fila.
 */
import type { INestApplication } from '@nestjs/common';
import { PrismaClient, ProvisionTenantResult, seedSriConfig } from '@vektra/db';
import { invalidateSriSettings } from '@vektra/einvoice';
import { createTestP12 } from '@vektra/sri-core/testing';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { createApp, makeTenant, ownerClient, randomRuc, seedPermissions, tokenFor, uniqueEmail } from './helpers';

const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('Catálogo, inventario e importación', () => {
  let owner: PrismaClient;
  let app: INestApplication;
  let T: ProvisionTenantResult;
  let token: string;
  let lookups: {
    units: { id: string; code: string }[];
    priceLists: { id: string; code: string }[];
    taxRates: { id: string; percentageCode: string }[];
    warehouses: { id: string; name: string }[];
  };
  const http = () => request(app.getHttpServer());
  const auth = () => ({ authorization: `Bearer ${token}` });
  const unit = (code: string) => lookups.units.find((u) => u.code === code)!.id;
  const list = (code: string) => lookups.priceLists.find((l) => l.code === code)!.id;
  const iva15 = () => lookups.taxRates.find((r) => r.percentageCode === '4')!.id;

  beforeAll(async () => {
    owner = ownerClient();
    await seedPermissions(owner);
    await seedSriConfig(owner);
    invalidateSriSettings();
    const email = uniqueEmail('catalogo');
    T = await makeTenant(owner, randomRuc(), email, 'hardware');
    app = await createApp();
    token = await tokenFor(app, email);
    lookups = (await http().get('/api/catalog/lookups').set(auth()).expect(200)).body;
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  let cementId: string;

  describe('productos', () => {
    it('crea un producto con presentación (saco/caja), códigos de barras y precios por lista', async () => {
      const res = await http()
        .post('/api/products')
        .set(auth())
        .send({
          code: 'CLAVO-2',
          name: 'Clavo de 2 pulgadas',
          unitId: unit('UND'),
          taxRateId: iva15(),
          minStock: '100',
          barcodes: ['7861000000017'],
          units: [{ unitId: unit('CAJA'), factor: '100', barcodes: ['7861000000024'] }],
          prices: [
            { priceListId: list('PUBLICO'), unitId: unit('UND'), price: '0.05' },
            { priceListId: list('PUBLICO'), unitId: unit('CAJA'), price: '4.00' },
            { priceListId: list('MAYORISTA'), unitId: unit('CAJA'), price: '3.50' },
          ],
        })
        .expect(201);
      cementId = res.body.id;
      const detail = await http().get(`/api/products/${cementId}`).set(auth()).expect(200);
      expect(detail.body.units).toEqual([{ unitId: unit('CAJA'), factor: '100', barcodes: ['7861000000024'] }]);
      expect(detail.body.prices).toHaveLength(3);
    });

    it('rechaza código repetido y código de barras de otro producto', async () => {
      const dup = await http().post('/api/products').set(auth()).send({ code: 'CLAVO-2', name: 'Otro', unitId: unit('UND'), taxRateId: iva15() }).expect(400);
      expect(dup.body.fields.code).toMatch(/Clavo de 2/);
      const bc = await http()
        .post('/api/products')
        .set(auth())
        .send({ code: 'X1', name: 'Otro', unitId: unit('UND'), taxRateId: iva15(), barcodes: ['7861000000024'] })
        .expect(400);
      expect(bc.body.fields.barcodes).toMatch(/ya está asignado/);
    });

    it('el buscador encuentra por código de barras y devuelve la presentación escaneada con su precio', async () => {
      const res = await http().get('/api/products/search').query({ q: '7861000000024' }).set(auth()).expect(200);
      expect(res.body).toHaveLength(1);
      const p = res.body[0];
      const box = p.units.find((u: { productUnitId: string }) => u.productUnitId === p.matchedUnitId);
      expect(box).toMatchObject({ code: 'CAJA', factor: '100', price: '4' });
      const byName = await http().get('/api/products/search').query({ q: 'clavo' }).set(auth()).expect(200);
      expect(byName.body[0].code).toBe('CLAVO-2');
    });
  });

  describe('clientes y proveedores', () => {
    it('valida la cédula/RUC y evita duplicados', async () => {
      const bad = await http().post('/api/parties').set(auth()).send({ idType: '05', identification: '1710034066', name: 'X' }).expect(400);
      expect(bad.body.fields.identification).toMatch(/verificador/);
      await http()
        .post('/api/parties')
        .set(auth())
        .send({ idType: '05', identification: '1710034065', name: 'Juan Pérez', email: 'juan@example.com', priceListId: list('MAYORISTA') })
        .expect(201);
      await http().post('/api/parties').set(auth()).send({ idType: '05', identification: '1710034065', name: 'Repetido' }).expect(409);
      const found = await http().get('/api/parties/by-identification/1710034065').set(auth()).expect(200);
      expect(found.body).toMatchObject({ name: 'Juan Pérez', priceListName: 'Mayorista' });
    });
  });

  describe('inventario', () => {
    let wh2: string;

    it('costo promedio ponderado: 10 u a $2,00 + 30 u a $3,00 = $2,75', async () => {
      const wh = lookups.warehouses[0].id;
      for (const [quantity, unitCost] of [['10', '2'], ['30', '3']]) {
        await http()
          .post('/api/inventory/adjustments')
          .set(auth())
          .send({ warehouseId: wh, direction: 'IN', reason: 'Compra inicial', items: [{ productId: cementId, quantity, unitCost }] })
          .expect(201);
      }
      const k = await http().get(`/api/inventory/kardex/${cementId}`).set(auth()).expect(200);
      expect(k.body.items[0]).toMatchObject({ balanceAfter: '40', avgCostAfter: '2.7500', typeLabel: 'Ajuste (entrada)' });
    });

    it('sin stock suficiente y con stock negativo desactivado → error claro', async () => {
      await owner.tenant.update({ where: { id: T.tenantId }, data: { settings: { allowNegativeStock: false } } });
      const res = await http()
        .post('/api/inventory/adjustments')
        .set(auth())
        .send({ warehouseId: lookups.warehouses[0].id, direction: 'OUT', reason: 'Merma', items: [{ productId: cementId, quantity: '41' }] })
        .expect(422);
      expect(res.body.message).toMatch(/Stock insuficiente.*disponible 40/);
    });

    it('transferencia entre bodegas conserva el costo promedio', async () => {
      const created = await http()
        .post('/api/warehouses')
        .set(auth())
        .send({ establishmentId: T.establishmentId, name: 'Bodega 2', isDefault: false, active: true })
        .expect(201);
      wh2 = created.body.id;
      await http()
        .post('/api/inventory/transfers')
        .set(auth())
        .send({ fromWarehouseId: lookups.warehouses[0].id, toWarehouseId: wh2, items: [{ productId: cementId, quantity: '15' }] })
        .expect(201);
      const s2 = await http().get('/api/inventory/stock').query({ warehouseId: wh2 }).set(auth()).expect(200);
      expect(s2.body.items.find((i: { code: string }) => i.code === 'CLAVO-2')).toMatchObject({ quantity: '15', avgCost: '2.7500' });
      const all = await http().get('/api/inventory/stock').set(auth()).expect(200);
      expect(all.body.items.find((i: { code: string }) => i.code === 'CLAVO-2').quantity).toBe('40');
    });

    it('vender por factura una caja (100 u) descuenta 100 de la bodega principal; sin stock no se emite', async () => {
      await owner.sriSetting.update({ where: { key: 'ws.test' }, data: { value: { reception: 'http://127.0.0.1:1/R', authorization: 'http://127.0.0.1:1/A' } } });
      invalidateSriSettings();
      await http().post('/api/einvoice/certificate').set(auth()).attach('file', createTestP12('x123'), 'f.p12').field('password', 'x123').expect(200);
      const search = (await http().get('/api/products/search').query({ q: '7861000000024' }).set(auth())).body[0];
      const box = search.units.find((u: { code: string }) => u.code === 'CAJA');
      const sale = (quantity: string, total: string) => ({
        emissionPointId: T.emissionPointId,
        buyer: { idType: '05', id: '1710034065', name: 'Juan Pérez' },
        lines: [{ productId: search.id, productUnitId: box.productUnitId, description: search.name, quantity, unitPrice: box.price, taxRateId: search.taxRateId }],
        payments: [{ sriCode: '01', method: 'efectivo', amount: total }],
      });
      // Principal tiene 25 (40 − 15 transferidas): 1 caja = 100 → sin stock, no se emite
      const fail = await http().post('/api/einvoice/invoices').set(auth()).send(sale('1', '4.60')).expect(422);
      expect(fail.body.message).toMatch(/Stock insuficiente/);
      expect(await owner.sequenceCounter.count({ where: { emissionPointId: T.emissionPointId } })).toBe(0);
      // Con stock negativo permitido sí se emite y el kárdex registra la venta
      await owner.tenant.update({ where: { id: T.tenantId }, data: { settings: { allowNegativeStock: true } } });
      const ok = await http().post('/api/einvoice/invoices').set(auth()).send(sale('1', '4.60')).expect(201);
      const k = await http().get(`/api/inventory/kardex/${search.id}`).set(auth()).expect(200);
      expect(k.body.items[0]).toMatchObject({ typeLabel: 'Venta', quantity: '-100', balanceAfter: '-75', documentId: ok.body.documentId });
    });
  });

  describe('importación Excel', () => {
    async function fillTemplate(kind: string, rows: (string | number)[][]): Promise<Buffer> {
      const tpl = await http().get(`/api/imports/templates/${kind}`).set(auth()).buffer(true).parse(binary).expect(200);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(tpl.body as unknown as ArrayBuffer);
      const ws = wb.getWorksheet('Datos')!;
      for (const r of rows) ws.addRow(r);
      return Buffer.from(await wb.xlsx.writeBuffer());
    }

    it('plantilla con columnas de cada lista de precios e instrucciones', async () => {
      const tpl = await http().get('/api/imports/templates/products').set(auth()).buffer(true).parse(binary).expect(200);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(tpl.body as unknown as ArrayBuffer);
      const headers = (wb.getWorksheet('Datos')!.getRow(1).values as string[]).filter(Boolean);
      expect(headers).toEqual(expect.arrayContaining(['Código*', 'Nombre*', 'Precio Público*', 'Precio Mayorista', 'Precio Distribuidor']));
      expect(wb.getWorksheet('Instrucciones')).toBeDefined();
    });

    it('importa 2.000 productos y reporta los errores fila por fila', async () => {
      // Columnas: Código, Nombre, Código barras, Categoría, Marca, Unidad, IVA, Público, Mayorista, Distribuidor, Incluye IVA, Stock mín, Servicio
      const rows: (string | number)[][] = [];
      for (let i = 1; i <= 2000; i++) {
        rows.push([`P${String(i).padStart(5, '0')}`, `Producto de prueba ${i}`, `789${String(i).padStart(10, '0')}`, `Categoría ${i % 7}`, `Marca ${i % 5}`, i % 10 === 0 ? 'KG' : 'UND', i % 3 === 0 ? '0%' : '15%', (i * 0.37).toFixed(2), (i * 0.33).toFixed(2), '', 'NO', 5, 'NO']);
      }
      rows[9][1] = ''; // fila 11: sin nombre
      rows[19][7] = 'doce'; // fila 21: precio inválido
      rows[29][0] = 'P00001'; // fila 31: código repetido
      rows[39][5] = 'BARRIL'; // fila 41: unidad inexistente
      const file = await fillTemplate('products', rows);

      const started = Date.now();
      const preview = await http().post('/api/imports/products/preview').set(auth()).attach('file', file, 'productos.xlsx').expect(200);
      expect(preview.body.total).toBe(2000);
      expect(preview.body.valid).toBe(1996);
      expect(preview.body.errors).toEqual([
        { row: 11, column: 'Nombre', message: 'Obligatorio' },
        { row: 21, column: 'Precio Público', message: '"doce" no es un precio válido' },
        { row: 31, column: 'Código', message: 'Repetido en el archivo (fila 2)' },
        { row: 41, column: 'Unidad', message: 'Unidad "BARRIL" no existe' },
      ]);
      const commit = await http().post(`/api/imports/${preview.body.id}/commit`).set(auth()).expect(200);
      const elapsed = Date.now() - started;
      expect(commit.body).toMatchObject({ created: 1996, updated: 0 });
      // eslint-disable-next-line no-console
      console.log(`Importación de 2.000 productos: vista previa + confirmación en ${elapsed} ms`);
      expect(elapsed).toBeLessThan(60_000);

      const list = await http().get('/api/products').query({ search: 'Producto de prueba 1999' }).set(auth()).expect(200);
      expect(list.body.items[0]).toMatchObject({ code: 'P01999', category: 'Categoría 4', price: '739.63' });
      await http().post(`/api/imports/${preview.body.id}/commit`).set(auth()).expect(409); // no se confirma dos veces
    }, 120_000);

    it('reimportar actualiza en lugar de duplicar; precios con IVA se convierten a sin IVA', async () => {
      const file = await fillTemplate('products', [['P00002', 'Producto 2 renombrado', '', '', '', 'UND', '15%', '1.15', '', '', 'SI', 0, 'NO']]);
      const preview = await http().post('/api/imports/products/preview').set(auth()).attach('file', file, 'p.xlsx').expect(200);
      expect(preview.body.updates).toBe(1);
      expect((await http().post(`/api/imports/${preview.body.id}/commit`).set(auth()).expect(200)).body).toMatchObject({ created: 0, updated: 1 });
      const p = await http().get('/api/products').query({ search: 'renombrado' }).set(auth()).expect(200);
      expect(p.body.items[0]).toMatchObject({ price: '1.00', priceWithTax: '1.15' });
    });

    it('saldos iniciales y clientes desde Excel', async () => {
      const stock = await fillTemplate('initial_stock', [['P00003', '', 12, '1.50'], ['NOEXISTE', '', 1, '1']]);
      const sp = await http().post('/api/imports/initial_stock/preview').set(auth()).attach('file', stock, 's.xlsx').expect(200);
      expect(sp.body.errors).toEqual([{ row: 3, column: 'Código producto', message: 'El producto NOEXISTE no existe (impórtelo primero)' }]);
      await http().post(`/api/imports/${sp.body.id}/commit`).set(auth()).expect(200);
      const k = await owner.inventoryMovement.findFirstOrThrow({ where: { tenantId: T.tenantId, product: { code: 'P00003' } } });
      expect(k.type).toBe('INITIAL');
      expect(k.balanceAfter.toString()).toBe('12');

      const parties = await fillTemplate('parties', [['', '0102030400', 'MARÍA LÓPEZ', '', 'maria@example.com', '', '', 'SI', 'NO', 'Mayorista', 100, 30], ['RUC', '1790012345001', 'ACME S.A.', '', '', '', '', 'NO', 'SI', '', 0, 0], ['', '123', 'X', '', 'no-es-correo', '', '', '', '', '', '', '']]);
      const pp = await http().post('/api/imports/parties/preview').set(auth()).attach('file', parties, 'c.xlsx').expect(200);
      expect(pp.body.valid).toBe(2);
      expect(pp.body.errors.map((e: { row: number; column: string }) => `${e.row}:${e.column}`)).toEqual(['4:Tipo identificación', '4:Email']);
      expect((await http().post(`/api/imports/${pp.body.id}/commit`).set(auth()).expect(200)).body.created).toBe(2);
    });
  });

  it('otra empresa no ve los productos ni puede buscarlos', async () => {
    const email = uniqueEmail('ajena');
    await makeTenant(owner, randomRuc(), email);
    const other = await tokenFor(app, email);
    const res = await http().get('/api/products').set({ authorization: `Bearer ${other}` }).expect(200);
    expect(res.body.total).toBe(0);
    expect((await http().get('/api/products/search').query({ q: 'clavo' }).set({ authorization: `Bearer ${other}` })).body).toEqual([]);
    await http().get(`/api/products/${cementId}`).set({ authorization: `Bearer ${other}` }).expect(404);
  });
});
