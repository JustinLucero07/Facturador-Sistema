import { uuidv7 } from '@vektra/db/uuid';
import type { CatalogLookups, PartyItem, ProductSearchItem, QuickProductRequest } from '@vektra/shared-contracts';
import { partySchema, quickProductSchema } from '@vektra/shared-contracts';
import { validateCedula, validateRuc } from '@vektra/shared-domain';
import { EngineContext } from './context';
import { LocalUser, requirePerm } from './auth';
import { D, fold, HttpError, json, qty, unprocessable } from './util';

interface ProductRow {
  id: string;
  code: string;
  name: string;
  aux_code: string | null;
  unit_id: string;
  tax_rate_id: string;
  is_service: number;
  active: number;
}

interface PartyRow {
  id: string;
  id_type: string;
  identification: string;
  name: string;
  trade_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  price_list_id: string | null;
  credit_limit: string;
  credit_days: number;
  active: number;
  created_at: string;
}

export function identificationError(idType: string, id: string): string | null {
  if (id === '9999999999999') return 'La identificación de consumidor final no se registra como cliente';
  if (idType === '04') {
    const r = validateRuc(id);
    return r.valid ? null : (r.error ?? 'RUC inválido');
  }
  if (idType === '05') {
    const r = validateCedula(id);
    return r.valid ? null : (r.error ?? 'Cédula inválida');
  }
  return null;
}

export class LocalCatalog {
  constructor(private readonly ctx: EngineContext) {}

  /**
   * Stock disponible en la caja: lo que reportó el servidor en la última sincronización menos lo
   * vendido en facturas que aún no se envían (unidades base).
   */
  availableStock(productIds: string[]): Map<string, string> {
    const out = new Map<string, InstanceType<typeof D>>();
    if (!productIds.length) return new Map();
    const marks = productIds.map(() => '?').join(',');
    for (const r of this.ctx.db.all<{ product_id: string; quantity: string }>(`SELECT * FROM stock WHERE product_id IN (${marks})`, ...productIds)) {
      out.set(r.product_id, new D(r.quantity));
    }
    const wanted = new Set(productIds);
    for (const d of this.ctx.db.all<{ lines: string }>("SELECT lines FROM documents WHERE status = 'PENDING_SYNC'")) {
      for (const l of json<{ productId: string | null; baseQty: string }[]>(d.lines, [])) {
        if (l.productId && wanted.has(l.productId)) out.set(l.productId, (out.get(l.productId) ?? new D(0)).minus(l.baseQty));
      }
    }
    // Devoluciones aún no enviadas: la mercadería ya volvió al estante.
    for (const n of this.ctx.db.all<{ lines: string }>("SELECT lines FROM credit_notes WHERE status = 'PENDING_SYNC'")) {
      for (const l of json<{ productId: string | null; restockQty: string }[]>(n.lines, [])) {
        if (l.productId && wanted.has(l.productId)) out.set(l.productId, (out.get(l.productId) ?? new D(0)).plus(l.restockQty));
      }
    }
    return new Map(productIds.map((id) => [id, qty(out.get(id) ?? 0)]));
  }

  search(term: string, priceListId?: string, limit = 20): ProductSearchItem[] {
    const cfg = this.ctx.requireConfig();
    const q = term.trim();
    if (!q) return [];
    const byBarcode = this.ctx.db.get<{ product_id: string; product_unit_id: string | null }>('SELECT * FROM product_barcodes WHERE barcode = ?', q);
    let rows: ProductRow[];
    if (byBarcode) rows = this.ctx.db.all<ProductRow>('SELECT * FROM products WHERE id = ? AND active = 1', byBarcode.product_id);
    else {
      const f = fold(q);
      rows = this.ctx.db.all<ProductRow>(
        `SELECT * FROM products WHERE active = 1 AND (lower(code) = ? OR search LIKE ?)
         ORDER BY (lower(code) = ?) DESC, name COLLATE NOCASE LIMIT ?`,
        q.toLowerCase(),
        `%${f}%`,
        q.toLowerCase(),
        Math.min(limit, 50),
      );
    }
    if (!rows.length) return [];
    const listId = priceListId ?? cfg.priceLists.find((p) => p.isDefault)?.id;
    const stock = this.availableStock(rows.filter((r) => !r.is_service).map((r) => r.id));
    const units = new Map(cfg.units.map((u) => [u.id, u]));
    const rates = new Map(cfg.taxRates.map((r) => [r.id, r]));
    return rows.map((p) => {
      const rate = rates.get(p.tax_rate_id);
      const pus = this.ctx.db.all<{ id: string; unit_id: string; factor: string; is_base: number }>(
        'SELECT * FROM product_units WHERE product_id = ? ORDER BY is_base DESC',
        p.id,
      );
      const prices = listId
        ? this.ctx.db.all<{ product_unit_id: string; price: string }>('SELECT product_unit_id, price FROM product_prices WHERE product_id = ? AND price_list_id = ?', p.id, listId)
        : [];
      return {
        id: p.id,
        code: p.code,
        name: p.name,
        auxCode: p.aux_code,
        isService: !!p.is_service,
        taxRateId: p.tax_rate_id,
        taxLabel: rate?.label ?? '',
        taxRate: rate?.rate ?? '0.00',
        matchedUnitId: byBarcode?.product_unit_id ?? null,
        units: pus.map((u) => {
          const unit = units.get(u.unit_id);
          return {
            productUnitId: u.id,
            unitId: u.unit_id,
            code: unit?.code ?? '',
            name: unit?.name ?? '',
            factor: qty(u.factor),
            allowsDecimal: unit?.allowsDecimal ?? false,
            isBase: !!u.is_base,
            price: prices.find((x) => x.product_unit_id === u.id)?.price ?? null,
          };
        }),
        stock: p.is_service ? null : (stock.get(p.id) ?? '0'),
      };
    });
  }

  lookups(): CatalogLookups {
    const cfg = this.ctx.requireConfig();
    return {
      units: cfg.units.map((u) => ({ ...u, active: true })),
      categories: [],
      brands: [],
      priceLists: cfg.priceLists.map((p, i) => ({ ...p, sortOrder: i, active: true })),
      taxRates: cfg.taxRates.filter((r) => r.taxCode === '2').map((r) => ({ id: r.id, label: r.label, name: r.name, rate: r.rate, percentageCode: r.percentageCode })),
      warehouses: cfg.emissionPoint.warehouseId
        ? [{ id: cfg.emissionPoint.warehouseId, name: 'Bodega principal', establishment: cfg.emissionPoint.establishmentName, isDefault: true }]
        : [],
    };
  }

  /** Alta rápida de producto en la caja: queda para venta inmediata y se envía al servidor. */
  quickProduct(user: LocalUser, body: unknown): { id: string } {
    requirePerm(user, 'catalog.manage');
    const parsed = quickProductSchema.safeParse(body);
    if (!parsed.success) throw unprocessable('Revise los datos del producto', parsed.error.issues.map((i) => i.message));
    const p = parsed.data;
    const cfg = this.ctx.requireConfig();
    if (!cfg.units.some((u) => u.id === p.unitId)) throw unprocessable('Unidad inválida');
    if (!cfg.taxRates.some((r) => r.id === p.taxRateId)) throw unprocessable('Tarifa de IVA inválida');
    const list = cfg.priceLists.find((l) => l.isDefault) ?? cfg.priceLists[0];
    this.ctx.db.tx(() => {
      if (this.ctx.db.get('SELECT 1 FROM products WHERE lower(code) = ?', p.code.toLowerCase())) {
        throw new HttpError(409, `Ya existe un producto con el código ${p.code}`);
      }
      if (p.barcode && this.ctx.db.get('SELECT 1 FROM product_barcodes WHERE barcode = ?', p.barcode)) {
        throw new HttpError(409, `El código de barras ${p.barcode} ya pertenece a otro producto`);
      }
      this.ctx.db.run(
        'INSERT INTO products (id, code, name, aux_code, unit_id, tax_rate_id, is_service, active, search, local) VALUES (?, ?, ?, NULL, ?, ?, ?, 1, ?, 1)',
        p.id,
        p.code,
        p.name,
        p.unitId,
        p.taxRateId,
        p.isService ? 1 : 0,
        fold(`${p.code} ${p.name}`),
      );
      this.ctx.db.run('INSERT INTO product_units (id, product_id, unit_id, factor, is_base) VALUES (?, ?, ?, ?, 1)', p.productUnitId, p.id, p.unitId, '1');
      if (p.barcode) this.ctx.db.run('INSERT INTO product_barcodes (barcode, product_id, product_unit_id) VALUES (?, ?, NULL)', p.barcode, p.id);
      if (list) this.ctx.db.run('INSERT INTO product_prices (price_list_id, product_unit_id, product_id, price) VALUES (?, ?, ?, ?)', list.id, p.productUnitId, p.id, p.price);
      this.ctx.enqueue('product.create', p satisfies QuickProductRequest, user.id);
    });
    return { id: p.id };
  }

  // ───────── Clientes ─────────

  private partyItem(r: PartyRow): PartyItem {
    const cfg = this.ctx.config;
    return {
      id: r.id,
      idType: r.id_type as PartyItem['idType'],
      identification: r.identification,
      name: r.name,
      tradeName: r.trade_name,
      email: r.email,
      phone: r.phone,
      address: r.address,
      isCustomer: true,
      isSupplier: false,
      priceListId: r.price_list_id,
      priceListName: cfg?.priceLists.find((p) => p.id === r.price_list_id)?.name ?? null,
      creditLimit: r.credit_limit,
      creditDays: r.credit_days,
      notes: null,
      active: !!r.active,
      customFields: {},
      createdAt: r.created_at,
    };
  }

  partyByIdentification(id: string): PartyItem | null {
    const r = this.ctx.db.get<PartyRow>('SELECT * FROM parties WHERE identification = ?', id.trim());
    return r ? this.partyItem(r) : null;
  }

  /** Crea o actualiza un cliente en la caja; el servidor lo fusiona por identificación. */
  saveParty(user: LocalUser, id: string | null, body: unknown): { id: string } {
    requirePerm(user, 'customers.manage');
    const parsed = partySchema.safeParse(body);
    if (!parsed.success) throw unprocessable('Revise los datos', parsed.error.issues.map((i) => i.message));
    const p = parsed.data;
    if (p.idType === '04' || p.idType === '05') {
      const err = identificationError(p.idType, p.identification);
      if (err) throw new HttpError(400, 'Revise los datos', [err]);
    }
    const partyId = this.ctx.db.tx(() => {
      const existing = this.ctx.db.get<PartyRow>('SELECT * FROM parties WHERE identification = ?', p.identification);
      if (existing && existing.id !== id) throw new HttpError(409, `Ya existe un cliente con la identificación ${p.identification}`);
      const newId = id ?? uuidv7();
      if (existing || id) {
        this.ctx.db.run(
          'UPDATE parties SET id_type = ?, name = ?, email = ?, phone = ?, address = ? WHERE id = ?',
          p.idType,
          p.name,
          p.email,
          p.phone,
          p.address,
          newId,
        );
      } else {
        this.ctx.db.run(
          'INSERT INTO parties (id, id_type, identification, name, trade_name, email, phone, address, price_list_id, credit_limit, credit_days, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, 1, ?)',
          newId,
          p.idType,
          p.identification,
          p.name,
          p.tradeName,
          p.email,
          p.phone,
          p.address,
          '0.00',
          this.ctx.now().toISOString(),
        );
      }
      this.ctx.enqueue(
        'party.upsert',
        { id: newId, idType: p.idType, identification: p.identification, name: p.name, email: p.email, phone: p.phone, address: p.address },
        user.id,
      );
      return newId;
    });
    return { id: partyId };
  }
}

