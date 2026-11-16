import { createQuickProduct, QuickProduct } from './quick-product';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Tx, uuidv7 } from '@vektra/db';
import type { Paginated, ProductDetail, ProductListItem, ProductParsed, ProductSearchItem } from '@vektra/shared-contracts';
import Decimal from 'decimal.js';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../common/prisma.service';
import { currentContext } from '../common/request-context';

const D = Decimal.clone({ rounding: Decimal.ROUND_HALF_UP });
const qty = (v: Prisma.Decimal | string | number) => new D(v.toString()).toDecimalPlaces(6).toString();

export interface ProductQuery {
  search?: string;
  categoryId?: string;
  lowStock?: boolean;
  active?: boolean;
  page: number;
  pageSize: number;
}

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async quick(p: QuickProduct): Promise<{ id: string }> {
    const tenantId = currentContext().tenantId as string;
    await this.prisma.tx(async (tx) => {
      if (!(await createQuickProduct(tx, tenantId, p))) return;
      await this.audit.record(tx, { action: 'create', entity: 'product', entityId: p.id, after: { code: p.code, name: p.name, quick: true } });
    });
    return { id: p.id };
  }

  private canSeeCosts(): boolean {
    return currentContext().permissions?.has('catalog.costs') ?? false;
  }

  // ───────── Listado ─────────

  async list(q: ProductQuery): Promise<Paginated<ProductListItem>> {
    const s = q.search?.trim();
    const like = s ? `%${s.toLowerCase()}%` : null;
    const where = Prisma.sql`
      WHERE 1 = 1
      ${s ? Prisma.sql`AND (lower(p.name) LIKE ${like} OR lower(p.code) LIKE ${like} OR EXISTS (SELECT 1 FROM product_barcode b WHERE b.product_id = p.id AND b.barcode = ${s}))` : Prisma.empty}
      ${q.categoryId ? Prisma.sql`AND p.category_id = ${q.categoryId}::uuid` : Prisma.empty}
      ${q.active !== undefined ? Prisma.sql`AND p.active = ${q.active}` : Prisma.empty}
      ${q.lowStock ? Prisma.sql`AND NOT p.is_service AND p.min_stock > 0 AND COALESCE(st.qty, 0) <= p.min_stock` : Prisma.empty}`;
    const from = Prisma.sql`FROM product p LEFT JOIN (SELECT product_id, SUM(quantity) AS qty FROM stock GROUP BY product_id) st ON st.product_id = p.id`;

    const { rows, total, defaultList } = await this.prisma.tx(async (tx) => {
      const [{ count }] = await tx.$queryRaw<{ count: bigint }[]>`SELECT count(*) AS count ${from} ${where}`;
      const ids = await tx.$queryRaw<{ id: string; qty: string | null }[]>`
        SELECT p.id, st.qty::text AS qty ${from} ${where} ORDER BY p.name COLLATE es_natural, p.code LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`;
      const defaultList = await tx.priceList.findFirst({ where: { isDefault: true } });
      const products = await tx.product.findMany({
        where: { id: { in: ids.map((i) => i.id) } },
        include: { category: true, brand: true, units: true, prices: defaultList ? { where: { priceListId: defaultList.id } } : false },
      });
      const byId = new Map(products.map((p) => [p.id, p]));
      return { rows: ids.map((i) => ({ p: byId.get(i.id)!, qty: i.qty ?? '0' })), total: Number(count), defaultList };
    });
    const [units, rates] = await Promise.all([this.unitsById(rows.map((r) => r.p.unitId)), this.rates()]);
    const costs = this.canSeeCosts();
    return {
      total,
      page: q.page,
      pageSize: q.pageSize,
      items: rows.map(({ p, qty: stockQty }) => {
        const base = p.units.find((u) => u.isBase);
        const price = defaultList && base ? (p.prices ?? []).find((x) => x.productUnitId === base.id)?.price : undefined;
        const rate = rates.get(p.taxRateId);
        return {
          id: p.id,
          code: p.code,
          name: p.name,
          category: p.category?.name ?? null,
          brand: p.brand?.name ?? null,
          unit: units.get(p.unitId)?.code ?? '',
          taxLabel: rate?.label ?? '',
          price: price ? new D(price.toString()).toFixed(2) : null,
          priceWithTax: price && rate ? new D(price.toString()).mul(new D(rate.rate.toString()).div(100).plus(1)).toFixed(2) : null,
          stock: p.isService ? '' : qty(stockQty),
          minStock: qty(p.minStock),
          avgCost: costs ? new D(p.avgCost.toString()).toFixed(4) : null,
          isService: p.isService,
          active: p.active,
          lowStock: !p.isService && new D(p.minStock.toString()).gt(0) && new D(stockQty).lte(p.minStock.toString()),
          imageUrl: p.imageUrl && p.imageUrl.length < 2048 ? p.imageUrl : p.imageUrl ? 'embedded' : null,
        };
      }),
    };
  }

  private async unitsById(ids: string[]) {
    const units = await this.prisma.tx((tx) => tx.unit.findMany({ where: { id: { in: [...new Set(ids)] } } }));
    return new Map(units.map((u) => [u.id, u]));
  }

  private async rates() {
    const rates = await this.prisma.client.taxRate.findMany();
    return new Map(rates.map((r) => [r.id, r]));
  }

  // ───────── Detalle ─────────

  async detail(id: string): Promise<ProductDetail> {
    const p = await this.prisma.tx((tx) =>
      tx.product.findFirst({
        where: { id },
        include: { units: { include: { barcodes: true } }, barcodes: true, prices: true, stock: { include: { warehouse: true } } },
      }),
    );
    if (!p) throw new NotFoundException('Producto no encontrado');
    const base = p.units.find((u) => u.isBase);
    const unitIdOf = new Map(p.units.map((u) => [u.id, u.unitId]));
    const costs = this.canSeeCosts();
    return {
      id: p.id,
      code: p.code,
      name: p.name,
      description: p.description,
      categoryId: p.categoryId,
      brandId: p.brandId,
      unitId: p.unitId,
      taxRateId: p.taxRateId,
      auxCode: p.auxCode,
      isService: p.isService,
      minStock: qty(p.minStock),
      imageUrl: p.imageUrl,
      active: p.active,
      customFields: p.customFields as ProductDetail['customFields'],
      avgCost: costs ? p.avgCost.toString() : null,
      lastCost: costs ? p.lastCost.toString() : null,
      barcodes: p.barcodes.filter((b) => !b.productUnitId || b.productUnitId === base?.id).map((b) => b.barcode),
      units: p.units
        .filter((u) => !u.isBase)
        .map((u) => ({ unitId: u.unitId, factor: qty(u.factor), barcodes: u.barcodes.map((b) => b.barcode) })),
      prices: p.prices.map((x) => ({ priceListId: x.priceListId, unitId: unitIdOf.get(x.productUnitId) ?? '', price: x.price.toString() })),
      stock: p.stock.map((s) => ({ warehouseId: s.warehouseId, warehouse: s.warehouse.name, quantity: qty(s.quantity) })),
    };
  }

  // ───────── Alta / edición ─────────

  async create(input: ProductParsed): Promise<{ id: string }> {
    const tenantId = currentContext().tenantId as string;
    const id = uuidv7();
    await this.prisma.tx(async (tx) => {
      await this.validate(tx, input, null);
      await tx.product.create({ data: { id, tenantId, ...this.columns(input) } });
      await this.writeChildren(tx, tenantId, id, input, true);
      await this.audit.record(tx, { action: 'create', entity: 'product', entityId: id, after: { ...input, imageUrl: input.imageUrl ? '[imagen]' : null } });
    });
    return { id };
  }

  async update(id: string, input: ProductParsed): Promise<void> {
    const tenantId = currentContext().tenantId as string;
    await this.prisma.tx(async (tx) => {
      const before = await tx.product.findFirst({ where: { id } });
      if (!before) throw new NotFoundException('Producto no encontrado');
      await this.validate(tx, input, id);
      if (before.unitId !== input.unitId) {
        const moves = await tx.inventoryMovement.count({ where: { productId: id } });
        if (moves > 0) throw new ConflictException('No se puede cambiar la unidad base: el producto ya tiene movimientos de inventario');
      }
      if (before.isService !== input.isService) {
        const moves = await tx.inventoryMovement.count({ where: { productId: id } });
        if (moves > 0) throw new ConflictException('No se puede cambiar entre producto y servicio: ya tiene movimientos de inventario');
      }
      await tx.product.update({ where: { id }, data: this.columns(input) });
      await this.writeChildren(tx, tenantId, id, input, false);
      await this.audit.record(tx, {
        action: 'update',
        entity: 'product',
        entityId: id,
        before: { ...before, imageUrl: before.imageUrl ? '[imagen]' : null },
        after: { ...input, imageUrl: input.imageUrl ? '[imagen]' : null },
      });
    });
  }

  private columns(i: ProductParsed) {
    return {
      code: i.code,
      name: i.name,
      description: i.description ?? null,
      categoryId: i.categoryId ?? null,
      brandId: i.brandId ?? null,
      unitId: i.unitId,
      taxRateId: i.taxRateId,
      auxCode: i.auxCode ?? null,
      isService: i.isService,
      minStock: i.minStock,
      imageUrl: i.imageUrl ?? null,
      active: i.active,
      customFields: i.customFields,
    };
  }

  private async validate(tx: Tx, i: ProductParsed, id: string | null): Promise<void> {
    const fields: Record<string, string> = {};
    const dup = await tx.product.findFirst({ where: { code: i.code, ...(id ? { NOT: { id } } : {}) }, select: { name: true } });
    if (dup) fields['code'] = `El código ya lo usa "${dup.name}"`;
    const unitIds = [i.unitId, ...i.units.map((u) => u.unitId)];
    if (new Set(unitIds).size !== unitIds.length) fields['units'] = 'Hay unidades repetidas';
    const units = await tx.unit.count({ where: { id: { in: unitIds } } });
    if (units !== new Set(unitIds).size) fields['unitId'] = 'Unidad no encontrada';
    if (!(await this.prisma.client.taxRate.findFirst({ where: { id: i.taxRateId, active: true } }))) fields['taxRateId'] = 'Tarifa de IVA no vigente';
    if (i.categoryId && !(await tx.category.findFirst({ where: { id: i.categoryId } }))) fields['categoryId'] = 'Categoría no encontrada';
    if (i.brandId && !(await tx.brand.findFirst({ where: { id: i.brandId } }))) fields['brandId'] = 'Marca no encontrada';
    for (const u of i.units) if (new D(u.factor).lte(0)) fields['units'] = 'El factor de cada presentación debe ser mayor a cero';
    for (const pr of i.prices) if (!unitIds.includes(pr.unitId)) fields['prices'] = 'Hay precios para una unidad que el producto no tiene';
    const barcodes = [...i.barcodes, ...i.units.flatMap((u) => u.barcodes)];
    if (new Set(barcodes).size !== barcodes.length) fields['barcodes'] = 'Hay códigos de barras repetidos';
    if (barcodes.length) {
      const taken = await tx.productBarcode.findFirst({
        where: { barcode: { in: barcodes }, ...(id ? { NOT: { productId: id } } : {}) },
        include: { product: { select: { name: true } } },
      });
      if (taken) fields['barcodes'] = `El código de barras ${taken.barcode} ya está asignado a "${taken.product.name}"`;
    }
    if (Object.keys(fields).length) throw new BadRequestException({ message: 'Revise los datos del producto', fields });
  }

  /** Unidades, códigos de barras y precios. Mantiene estables los IDs de presentaciones existentes. */
  private async writeChildren(tx: Tx, tenantId: string, productId: string, i: ProductParsed, isNew: boolean): Promise<void> {
    const existing = isNew ? [] : await tx.productUnit.findMany({ where: { productId } });
    const wanted = [{ unitId: i.unitId, factor: '1', isBase: true, barcodes: i.barcodes }, ...i.units.map((u) => ({ ...u, isBase: false }))];
    const idByUnit = new Map<string, string>();
    for (const w of wanted) {
      const current = existing.find((e) => e.unitId === w.unitId);
      if (current) {
        await tx.productUnit.update({ where: { id: current.id }, data: { factor: w.factor, isBase: w.isBase } });
        idByUnit.set(w.unitId, current.id);
      } else {
        const id = uuidv7();
        await tx.productUnit.create({ data: { id, tenantId, productId, unitId: w.unitId, factor: w.factor, isBase: w.isBase } });
        idByUnit.set(w.unitId, id);
      }
    }
    const removed = existing.filter((e) => !wanted.some((w) => w.unitId === e.unitId)).map((e) => e.id);
    if (removed.length) await tx.productUnit.deleteMany({ where: { id: { in: removed } } });

    await tx.productBarcode.deleteMany({ where: { productId } });
    const barcodeRows = wanted.flatMap((w) => w.barcodes.map((barcode) => ({ id: uuidv7(), tenantId, productId, productUnitId: idByUnit.get(w.unitId)!, barcode })));
    if (barcodeRows.length) await tx.productBarcode.createMany({ data: barcodeRows });

    await tx.productPrice.deleteMany({ where: { productId } });
    const priceRows = i.prices.map((p) => ({ id: uuidv7(), tenantId, productId, priceListId: p.priceListId, productUnitId: idByUnit.get(p.unitId)!, price: p.price }));
    if (priceRows.length) await tx.productPrice.createMany({ data: priceRows });
  }

  // ───────── Buscador (factura / POS) ─────────

  /**
   * Busca por código de barras exacto (devuelve la presentación escaneada), código o nombre.
   * Precios de la lista indicada (o la lista por defecto) y stock de la bodega indicada.
   */
  async search(q: string, opts: { priceListId?: string; warehouseId?: string; limit?: number }): Promise<ProductSearchItem[]> {
    const term = q.trim();
    if (!term) return [];
    const limit = Math.min(opts.limit ?? 20, 50);
    const rates = await this.rates();
    return this.prisma.tx(async (tx) => {
      const byBarcode = await tx.productBarcode.findFirst({ where: { barcode: term }, select: { productId: true, productUnitId: true } });
      let ids: string[];
      if (byBarcode) ids = [byBarcode.productId];
      else {
        const like = `%${term.toLowerCase()}%`;
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM product WHERE active AND (lower(code) = ${term.toLowerCase()} OR lower(code) LIKE ${like} OR lower(name) LIKE ${like})
          ORDER BY (lower(code) = ${term.toLowerCase()}) DESC, name COLLATE es_natural LIMIT ${limit}`;
        ids = rows.map((r) => r.id);
      }
      if (!ids.length) return [];
      const listId = opts.priceListId ?? (await tx.priceList.findFirst({ where: { isDefault: true }, select: { id: true } }))?.id;
      const products = await tx.product.findMany({
        where: { id: { in: ids }, active: true },
        include: { units: true, prices: listId ? { where: { priceListId: listId } } : false, stock: opts.warehouseId ? { where: { warehouseId: opts.warehouseId } } : false },
      });
      const unitRows = await tx.unit.findMany({ where: { id: { in: products.flatMap((p) => p.units.map((u) => u.unitId)) } } });
      const unitById = new Map(unitRows.map((u) => [u.id, u]));
      const order = new Map(ids.map((id, k) => [id, k]));
      return products
        .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
        .map((p) => {
          const rate = rates.get(p.taxRateId);
          return {
            id: p.id,
            code: p.code,
            name: p.name,
            auxCode: p.auxCode,
            isService: p.isService,
            taxRateId: p.taxRateId,
            taxLabel: rate?.label ?? '',
            taxRate: rate?.rate.toFixed(2) ?? '0.00',
            matchedUnitId: byBarcode?.productUnitId ?? null,
            units: p.units
              .sort((a, b) => Number(b.isBase) - Number(a.isBase))
              .map((u) => {
                const unit = unitById.get(u.unitId);
                const price = (p.prices ?? []).find((x) => x.productUnitId === u.id)?.price;
                return {
                  productUnitId: u.id,
                  unitId: u.unitId,
                  code: unit?.code ?? '',
                  name: unit?.name ?? '',
                  factor: qty(u.factor),
                  allowsDecimal: unit?.allowsDecimal ?? false,
                  isBase: u.isBase,
                  price: price ? price.toString() : null,
                };
              }),
            stock: opts.warehouseId && !p.isService ? qty((p.stock ?? [])[0]?.quantity ?? 0) : null,
          };
        });
    });
  }
}
