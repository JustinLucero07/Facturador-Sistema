import { ForbiddenException, Injectable } from '@nestjs/common';
import { agingBucket, D, daysOverdue } from '@vektra/accounts';
import { Prisma, Tx } from '@vektra/db';
import { loadSriSettings } from '@vektra/einvoice';
import { ReportCell, ReportColumn, ReportKind, ReportQuery, ReportResult, SNAPSHOT_REPORTS, TAX_REPORTS } from '@vektra/shared-contracts';
import { PrismaService } from '../common/prisma.service';
import { currentContext } from '../common/request-context';

type Dec = InstanceType<typeof D>;
type Num = Prisma.Decimal | number | string | bigint | null;

const n = (v: Num): Dec => new D(v === null ? 0 : v.toString());
const m2 = (v: Num | Dec) => Number(new D(v === null ? 0 : v.toString()).toDecimalPlaces(2).toFixed(2));
const q4 = (v: Num | Dec) => Number(new D(v === null ? 0 : v.toString()).toDecimalPlaces(4).toString());
const iso = (d: Date) => d.toISOString().slice(0, 10);
const asDay = (s: string) => new Date(`${s}T00:00:00Z`);
const fmtDay = (s: string) => s.split('-').reverse().join('/');
const pct = (part: Dec, total: Dec) => (total.isZero() ? 0 : Number(part.div(total).times(100).toDecimalPlaces(2).toString()));

const col = (key: string, label: string, type: ReportColumn['type'] = 'text'): ReportColumn => ({ key, label, type });

const BUCKET_LABEL: Record<string, string> = { current: 'Por vencer', d30: '1 a 30 días', d60: '31 a 60 días', d90: '61 a 90 días', over90: 'Más de 90 días' };

/**
 * Reportes de gestión. Ventas = facturas (01) menos notas de crédito (04) emitidas en el rango,
 * excepto las rechazadas por el SRI (NO AUTORIZADO / DEVUELTA). Montos sin IVA salvo que se indique.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async run(query: ReportQuery): Promise<ReportResult> {
    const perms = currentContext().permissions;
    if (TAX_REPORTS.includes(query.kind) && !perms?.has('reports.tax')) throw new ForbiddenException('No tiene permiso para ver reportes tributarios');
    if (query.kind === 'receivables' && !perms?.has('reports.read') && !perms?.has('receivables.manage')) throw new ForbiddenException('No tiene permiso para ver la cartera');
    const subtitle = SNAPSHOT_REPORTS.includes(query.kind) ? `Al ${fmtDay(iso(new Date(Date.now() - 5 * 3600000)))}` : `Del ${fmtDay(query.from)} al ${fmtDay(query.to)}`;
    const base = await this.prisma.tx((tx) => this.build(tx, query));
    return { kind: query.kind, subtitle, notes: [], totals: null, ...base };
  }

  /** Condición de "venta válida" sobre el alias d (document). */
  private salesWhere(q: ReportQuery, docTypes: string[] = ['01', '04']): Prisma.Sql {
    return Prisma.sql`d.status = 'ISSUED'
      AND d.doc_type IN (${Prisma.join(docTypes)})
      AND d.issue_date BETWEEN ${asDay(q.from)} AND ${asDay(q.to)}
      AND NOT EXISTS (SELECT 1 FROM electronic_document e WHERE e.document_id = d.id AND e.status::text IN ('NOT_AUTHORIZED', 'RETURNED'))
      ${q.establishmentId ? Prisma.sql`AND d.establishment_id = ${q.establishmentId}::uuid` : Prisma.empty}`;
  }

  private async build(tx: Tx, q: ReportQuery): Promise<Omit<ReportResult, 'kind' | 'subtitle' | 'notes' | 'totals'> & Partial<Pick<ReportResult, 'notes' | 'totals'>>> {
    const sign = Prisma.sql`(CASE WHEN d.doc_type = '04' THEN -1 ELSE 1 END)`;
    switch (q.kind as ReportKind) {
      case 'sales_daily': {
        const rows = await tx.$queryRaw<{ day: Date; invoices: bigint; credit_notes: bigint; subtotal: Num; tax: Num; total: Num }[]>`
          SELECT d.issue_date AS day,
                 count(*) FILTER (WHERE d.doc_type = '01') AS invoices,
                 count(*) FILTER (WHERE d.doc_type = '04') AS credit_notes,
                 sum(${sign} * d.subtotal) AS subtotal, sum(${sign} * d.total_tax) AS tax, sum(${sign} * d.total) AS total
          FROM document d WHERE ${this.salesWhere(q)}
          GROUP BY d.issue_date ORDER BY d.issue_date`;
        const out = rows.map((r) => ({ day: iso(r.day), invoices: Number(r.invoices), creditNotes: Number(r.credit_notes), subtotal: m2(r.subtotal), tax: m2(r.tax), total: m2(r.total) }));
        return {
          title: 'Ventas por día',
          columns: [col('day', 'Fecha', 'date'), col('invoices', 'Facturas', 'number'), col('creditNotes', 'Notas de crédito', 'number'), col('subtotal', 'Subtotal', 'money'), col('tax', 'IVA', 'money'), col('total', 'Total', 'money')],
          rows: out,
          totals: sumRows(out, ['invoices', 'creditNotes', 'subtotal', 'tax', 'total'], { day: 'Total' }),
          notes: ['Las notas de crédito restan. Subtotal sin IVA; el total incluye IVA y propina.'],
        };
      }

      case 'sales_product':
      case 'sales_category': {
        const byCategory = q.kind === 'sales_category';
        const rows = byCategory
          ? await tx.$queryRaw<{ name: string; products: bigint; qty: Num; net: Num }[]>`
              SELECT coalesce(c.name, 'Sin categoría') AS name, count(DISTINCT l.product_id) AS products, NULL AS qty, sum(${sign} * l.subtotal) AS net
              FROM document_line l JOIN document d ON d.id = l.document_id
              LEFT JOIN product p ON p.id = l.product_id LEFT JOIN category c ON c.id = p.category_id
              WHERE ${this.salesWhere(q)} GROUP BY 1 ORDER BY net DESC`
          : await tx.$queryRaw<{ code: string | null; name: string; qty: Num; net: Num }[]>`
              SELECT coalesce(p.code, max(l.main_code)) AS code, coalesce(p.name, max(l.description) || ' (sin producto)') AS name,
                     sum(${sign} * l.quantity * l.unit_factor) AS qty, sum(${sign} * l.subtotal) AS net
              FROM document_line l JOIN document d ON d.id = l.document_id LEFT JOIN product p ON p.id = l.product_id
              WHERE ${this.salesWhere(q)} GROUP BY p.id, coalesce(l.product_id::text, l.description) ORDER BY net DESC`;
        const total = rows.reduce((a, r) => a.plus(n(r.net)), new D(0));
        if (byCategory) {
          const out = (rows as { name: string; products: bigint; net: Num }[]).map((r) => ({ name: r.name, products: Number(r.products), net: m2(r.net), share: pct(n(r.net), total) }));
          return {
            title: 'Ventas por categoría',
            columns: [col('name', 'Categoría'), col('products', 'Productos', 'number'), col('net', 'Ventas netas', 'money'), col('share', '% del total', 'percent')],
            rows: out,
            totals: { name: 'Total', products: null, net: m2(total), share: total.isZero() ? 0 : 100 },
            notes: ['Ventas netas sin IVA (facturas menos notas de crédito).'],
          };
        }
        const out = (rows as { code: string | null; name: string; qty: Num; net: Num }[]).map((r) => ({ code: r.code ?? '', name: r.name, qty: q4(r.qty), net: m2(r.net), share: pct(n(r.net), total) }));
        return {
          title: 'Ventas por producto',
          columns: [col('code', 'Código'), col('name', 'Producto'), col('qty', 'Cantidad (unidad base)', 'number'), col('net', 'Ventas netas', 'money'), col('share', '% del total', 'percent')],
          rows: out,
          totals: { code: 'Total', name: null, qty: null, net: m2(total), share: total.isZero() ? 0 : 100 },
          notes: ['Ventas netas sin IVA (facturas menos notas de crédito). Cantidad en la unidad base del producto.'],
        };
      }

      case 'sales_user': {
        const rows = await tx.$queryRaw<{ user_id: string | null; invoices: bigint; credit_notes: bigint; subtotal: Num; total: Num }[]>`
          SELECT d.created_by AS user_id, count(*) FILTER (WHERE d.doc_type = '01') AS invoices, count(*) FILTER (WHERE d.doc_type = '04') AS credit_notes,
                 sum(${sign} * d.subtotal) AS subtotal, sum(${sign} * d.total) AS total
          FROM document d WHERE ${this.salesWhere(q)} GROUP BY d.created_by ORDER BY total DESC`;
        const users = await this.prisma.client.user.findMany({ where: { id: { in: rows.map((r) => r.user_id).filter((x): x is string => !!x) } }, select: { id: true, fullName: true } });
        const out = rows.map((r) => ({
          user: r.user_id ? (users.find((u) => u.id === r.user_id)?.fullName ?? '—') : 'Caja de escritorio / sistema',
          invoices: Number(r.invoices),
          creditNotes: Number(r.credit_notes),
          subtotal: m2(r.subtotal),
          total: m2(r.total),
          average: Number(r.invoices) ? m2(n(r.total).div(Number(r.invoices))) : 0,
        }));
        return {
          title: 'Ventas por cajero / usuario',
          columns: [col('user', 'Usuario'), col('invoices', 'Facturas', 'number'), col('creditNotes', 'Notas de crédito', 'number'), col('subtotal', 'Subtotal', 'money'), col('total', 'Total', 'money'), col('average', 'Ticket promedio', 'money')],
          rows: out,
          totals: sumRows(out, ['invoices', 'creditNotes', 'subtotal', 'total'], { user: 'Total', average: null }),
          notes: ['Las notas de crédito restan del usuario que las emitió.'],
        };
      }

      case 'sales_payment': {
        const rows = await tx.$queryRaw<{ method: string; sri_code: string; docs: bigint; amount: Num }[]>`
          SELECT p.method, p.sri_code, count(DISTINCT d.id) AS docs, sum(p.amount) AS amount
          FROM document_payment p JOIN document d ON d.id = p.document_id
          WHERE ${this.salesWhere(q, ['01'])} GROUP BY p.method, p.sri_code ORDER BY amount DESC`;
        const settings = await loadSriSettings(this.prisma.client);
        const catalog = await this.prisma.client.sriCatalog.findMany({ where: { catalog: 'payment_method' } });
        const total = rows.reduce((a, r) => a.plus(n(r.amount)), new D(0));
        const out = rows.map((r) => ({
          method: settings.paymentMethods.find((m) => m.method === r.method)?.label ?? r.method,
          sri: `${r.sri_code} ${catalog.find((c) => c.code === r.sri_code)?.description ?? ''}`.trim(),
          docs: Number(r.docs),
          amount: m2(r.amount),
          share: pct(n(r.amount), total),
        }));
        return {
          title: 'Ventas por forma de pago',
          columns: [col('method', 'Medio de pago'), col('sri', 'Forma de pago SRI'), col('docs', 'Facturas', 'number'), col('amount', 'Valor', 'money'), col('share', '% del total', 'percent')],
          rows: out,
          totals: { method: 'Total', sri: null, docs: null, amount: m2(total), share: total.isZero() ? 0 : 100 },
          notes: ['Valores cobrados en las facturas (con IVA). No descuenta devoluciones con nota de crédito.'],
        };
      }

      case 'profit': {
        const rows = await tx.$queryRaw<{ code: string | null; name: string; is_service: boolean | null; qty: Num; net: Num; cost: Num }[]>`
          WITH s AS (
            SELECT l.product_id, coalesce(l.product_id::text, l.description) AS k, max(l.main_code) AS code, max(l.description) AS description,
                   sum(${sign} * l.quantity * l.unit_factor) AS qty, sum(${sign} * l.subtotal) AS net
            FROM document_line l JOIN document d ON d.id = l.document_id
            WHERE ${this.salesWhere(q)} GROUP BY l.product_id, coalesce(l.product_id::text, l.description)
          ), c AS (
            SELECT m.product_id, -sum(m.total_cost) AS cost
            FROM inventory_movement m JOIN document d ON d.id = m.document_id
            WHERE m.type IN ('SALE', 'SALE_RETURN') AND ${this.salesWhere(q)} GROUP BY m.product_id
          )
          SELECT coalesce(p.code, s.code) AS code, coalesce(p.name, s.description || ' (sin producto)') AS name, p.is_service, s.qty, s.net, coalesce(c.cost, 0) AS cost
          FROM s LEFT JOIN product p ON p.id = s.product_id LEFT JOIN c ON c.product_id = s.product_id
          ORDER BY s.net - coalesce(c.cost, 0) DESC`;
        let tNet = new D(0);
        let tCost = new D(0);
        const out = rows.map((r) => {
          const net = n(r.net);
          const cost = n(r.cost);
          tNet = tNet.plus(net);
          tCost = tCost.plus(cost);
          return { code: r.code ?? '', name: r.name, qty: q4(r.qty), net: m2(net), cost: m2(cost), profit: m2(net.minus(cost)), margin: pct(net.minus(cost), net) };
        });
        return {
          title: 'Utilidad por producto',
          columns: [
            col('code', 'Código'),
            col('name', 'Producto'),
            col('qty', 'Cantidad', 'number'),
            col('net', 'Ventas netas', 'money'),
            col('cost', 'Costo de ventas', 'money'),
            col('profit', 'Utilidad', 'money'),
            col('margin', 'Margen', 'percent'),
          ],
          rows: out,
          totals: { code: 'Total', name: null, qty: null, net: m2(tNet), cost: m2(tCost), profit: m2(tNet.minus(tCost)), margin: pct(tNet.minus(tCost), tNet) },
          notes: [
            'Costo de ventas = costo promedio del kárdex al momento de cada venta (las devoluciones lo restan).',
            'Servicios y líneas sin producto no tienen costo: su utilidad es igual a la venta.',
          ],
        };
      }

      case 'inventory': {
        const rows = await tx.$queryRaw<{ code: string; name: string; warehouse: string; category: string | null; qty: Num; avg_cost: Num; min_stock: Num }[]>`
          SELECT p.code, p.name, w.name AS warehouse, c.name AS category, s.quantity AS qty, p.avg_cost, p.min_stock
          FROM stock s JOIN product p ON p.id = s.product_id JOIN warehouse w ON w.id = s.warehouse_id LEFT JOIN category c ON c.id = p.category_id
          WHERE p.is_service = false AND s.quantity <> 0
            ${q.warehouseId ? Prisma.sql`AND s.warehouse_id = ${q.warehouseId}::uuid` : Prisma.empty}
            ${q.establishmentId ? Prisma.sql`AND w.establishment_id = ${q.establishmentId}::uuid` : Prisma.empty}
          ORDER BY p.name, w.name`;
        let total = new D(0);
        const out = rows.map((r) => {
          const value = n(r.qty).times(n(r.avg_cost));
          total = total.plus(value);
          return {
            code: r.code,
            name: r.name,
            category: r.category ?? '',
            warehouse: r.warehouse,
            qty: q4(r.qty),
            avgCost: Number(n(r.avg_cost).toDecimalPlaces(4).toString()),
            value: m2(value),
            low: n(r.min_stock).gt(0) && n(r.qty).lte(n(r.min_stock)) ? 'Bajo mínimo' : '',
          };
        });
        return {
          title: 'Inventario valorizado',
          columns: [
            col('code', 'Código'),
            col('name', 'Producto'),
            col('category', 'Categoría'),
            col('warehouse', 'Bodega'),
            col('qty', 'Existencia', 'number'),
            col('avgCost', 'Costo promedio', 'money'),
            col('value', 'Valor', 'money'),
            col('low', 'Alerta'),
          ],
          rows: out,
          totals: { code: 'Total', name: `${out.length} registros`, category: null, warehouse: null, qty: null, avgCost: null, value: m2(total), low: null },
          notes: ['Existencias actuales valoradas al costo promedio ponderado (sin IVA). Las existencias negativas restan.'],
        };
      }

      case 'purchases_supplier': {
        const rows = await tx.$queryRaw<{ name: string; identification: string; docs: bigint; subtotal: Num; tax: Num; total: Num; withheld: Num }[]>`
          SELECT pa.name, pa.identification, count(*) AS docs, sum(p.subtotal) AS subtotal, sum(p.total_tax) AS tax, sum(p.total) AS total,
                 coalesce(sum((SELECT sum(w.amount) FROM document r JOIN withholding_line w ON w.document_id = r.id
                               WHERE r.purchase_id = p.id AND r.doc_type = '07' AND r.status = 'ISSUED'
                                 AND NOT EXISTS (SELECT 1 FROM electronic_document e WHERE e.document_id = r.id AND e.status::text IN ('NOT_AUTHORIZED', 'RETURNED')))), 0) AS withheld
          FROM purchase p JOIN party pa ON pa.id = p.supplier_id
          WHERE p.status = 'REGISTERED' AND p.issue_date BETWEEN ${asDay(q.from)} AND ${asDay(q.to)}
          GROUP BY pa.id, pa.name, pa.identification ORDER BY total DESC`;
        const out = rows.map((r) => ({
          name: r.name,
          identification: r.identification,
          docs: Number(r.docs),
          subtotal: m2(r.subtotal),
          tax: m2(r.tax),
          total: m2(r.total),
          withheld: m2(r.withheld),
          payable: m2(n(r.total).minus(n(r.withheld))),
        }));
        return {
          title: 'Compras por proveedor',
          columns: [
            col('name', 'Proveedor'),
            col('identification', 'Identificación'),
            col('docs', 'Comprobantes', 'number'),
            col('subtotal', 'Subtotal', 'money'),
            col('tax', 'IVA', 'money'),
            col('total', 'Total', 'money'),
            col('withheld', 'Retenido', 'money'),
            col('payable', 'Neto a pagar', 'money'),
          ],
          rows: out,
          totals: sumRows(out, ['docs', 'subtotal', 'tax', 'total', 'withheld', 'payable'], { name: 'Total', identification: null }),
          notes: ['Por fecha de emisión del comprobante del proveedor. Retenido = retenciones emitidas (renta e IVA) que no fueron rechazadas por el SRI.'],
        };
      }

      case 'vat':
        return this.vat(tx, q);

      case 'receivables':
      case 'payables': {
        const side = q.kind === 'receivables' ? 'AR' : 'AP';
        const items = await tx.accountItem.findMany({ where: { side, status: 'OPEN' }, orderBy: [{ dueDate: 'asc' }] });
        const parties = await tx.party.findMany({ where: { id: { in: [...new Set(items.map((i) => i.partyId))] } }, select: { id: true, name: true, identification: true } });
        const today = new Date();
        const out = items
          .map((i) => {
            const p = parties.find((x) => x.id === i.partyId);
            const days = daysOverdue(i.dueDate, today);
            return {
              name: p?.name ?? '—',
              identification: p?.identification ?? '',
              number: i.number,
              issueDate: iso(i.issueDate),
              dueDate: iso(i.dueDate),
              days,
              bucket: BUCKET_LABEL[agingBucket(i.dueDate, today)],
              amount: m2(i.amount),
              balance: m2(i.balance),
            };
          })
          .sort((a, b) => a.name.localeCompare(b.name) || a.dueDate.localeCompare(b.dueDate));
        return {
          title: side === 'AR' ? 'Cartera por cobrar' : 'Cuentas por pagar',
          columns: [
            col('name', side === 'AR' ? 'Cliente' : 'Proveedor'),
            col('identification', 'Identificación'),
            col('number', 'Documento'),
            col('issueDate', 'Emisión', 'date'),
            col('dueDate', 'Vence', 'date'),
            col('days', 'Días vencido', 'number'),
            col('bucket', 'Antigüedad'),
            col('amount', 'Valor', 'money'),
            col('balance', 'Saldo', 'money'),
          ],
          rows: out,
          totals: sumRows(out, ['amount', 'balance'], { name: 'Total', identification: null, number: `${out.length} documentos`, issueDate: null, dueDate: null, days: null, bucket: null }),
          notes: ['Documentos pendientes a hoy. No incluye el saldo a favor (anticipos sin aplicar).'],
        };
      }

      case 'cash_sessions': {
        const from = new Date(`${q.from}T05:00:00Z`);
        const to = new Date(new Date(`${q.to}T05:00:00Z`).getTime() + 86400000);
        const sessions = await tx.cashSession.findMany({ where: { openedAt: { gte: from, lt: to } }, orderBy: { openedAt: 'asc' } });
        const points = await tx.emissionPoint.findMany({ where: { id: { in: [...new Set(sessions.map((s) => s.emissionPointId))] } }, include: { establishment: { select: { code: true, id: true } } } });
        const users = await this.prisma.client.user.findMany({ where: { id: { in: [...new Set(sessions.flatMap((s) => [s.openedBy, s.closedBy]).filter((x): x is string => !!x))] } }, select: { id: true, fullName: true } });
        const name = (id: string | null) => (id ? (users.find((u) => u.id === id)?.fullName ?? '—') : '');
        const sum = (j: unknown) => Object.values((j ?? {}) as Record<string, string>).reduce((a, v) => a.plus(v), new D(0));
        const fmt = (d: Date | null) => (d ? d.toLocaleString('es-EC', { timeZone: 'America/Guayaquil', dateStyle: 'short', timeStyle: 'short' }) : '');
        const out = sessions
          .filter((s) => !q.establishmentId || points.find((p) => p.id === s.emissionPointId)?.establishment.id === q.establishmentId)
          .map((s) => {
            const p = points.find((x) => x.id === s.emissionPointId);
            return {
              point: p ? `${p.establishment.code}-${p.code} ${p.name}` : '',
              openedBy: name(s.openedBy),
              openedAt: fmt(s.openedAt),
              closedAt: s.status === 'OPEN' ? 'Abierta' : fmt(s.closedAt),
              opening: m2(s.openingAmount),
              expected: s.expected ? m2(sum(s.expected)) : null,
              counted: s.counted ? m2(sum(s.counted)) : null,
              difference: s.difference !== null ? m2(s.difference) : null,
            };
          });
        return {
          title: 'Cierres de caja',
          columns: [
            col('point', 'Punto de emisión'),
            col('openedBy', 'Abrió'),
            col('openedAt', 'Apertura'),
            col('closedAt', 'Cierre'),
            col('opening', 'Fondo inicial', 'money'),
            col('expected', 'Esperado', 'money'),
            col('counted', 'Contado', 'money'),
            col('difference', 'Diferencia', 'money'),
          ],
          rows: out,
          totals: sumRows(out, ['expected', 'counted', 'difference'], { point: 'Total', openedBy: null, openedAt: null, closedAt: null, opening: null }),
          notes: ['Esperado y contado suman todas las formas de pago del arqueo. Diferencia negativa = faltante.'],
        };
      }
    }
  }

  /** Resumen de IVA y retenciones del período (ayuda para el formulario 104 y la declaración de retenciones). */
  private async vat(tx: Tx, q: ReportQuery) {
    const from = asDay(q.from);
    const to = asDay(q.to);
    const sign = Prisma.sql`(CASE WHEN d.doc_type = '04' THEN -1 ELSE 1 END)`;
    const sales = await tx.$queryRaw<{ code: string; rate: Num; base: Num; amount: Num }[]>`
      SELECT g->>'percentageCode' AS code, max((g->>'rate')::numeric) AS rate,
             sum(${sign} * (g->>'base')::numeric) AS base, sum(${sign} * (g->>'amount')::numeric) AS amount
      FROM document d, jsonb_array_elements(d.tax_summary) g
      WHERE ${this.salesWhere(q)} AND g->>'taxCode' = '2' GROUP BY 1 ORDER BY 2 DESC, 1`;
    const purchases = await tx.$queryRaw<{ code: string; rate: Num; base: Num; amount: Num }[]>`
      SELECT g->>'percentageCode' AS code, max((g->>'rate')::numeric) AS rate, sum((g->>'base')::numeric) AS base, sum((g->>'amount')::numeric) AS amount
      FROM purchase p, jsonb_array_elements(p.tax_summary) g
      WHERE p.status = 'REGISTERED' AND p.issue_date BETWEEN ${from} AND ${to} AND g->>'taxCode' = '2' GROUP BY 1 ORDER BY 2 DESC, 1`;
    const made = await tx.$queryRaw<{ tax: string; code: string; percentage: Num; base: Num; amount: Num }[]>`
      SELECT w.tax, w.code, w.percentage, sum(w.base) AS base, sum(w.amount) AS amount
      FROM withholding_line w JOIN document d ON d.id = w.document_id
      WHERE d.doc_type = '07' AND d.status = 'ISSUED' AND d.issue_date BETWEEN ${from} AND ${to}
        AND NOT EXISTS (SELECT 1 FROM electronic_document e WHERE e.document_id = d.id AND e.status::text IN ('NOT_AUTHORIZED', 'RETURNED'))
      GROUP BY w.tax, w.code, w.percentage ORDER BY w.tax DESC, w.code`;
    const received = await tx.accountMovement.findMany({ where: { side: 'AR', kind: 'WITHHOLDING', voidedAt: null, date: { gte: from, lte: to } }, select: { data: true } });
    const rates = await this.prisma.client.taxRate.findMany({ where: { taxCode: '2' } });
    const label = (code: string, rate: Num) => rates.find((r) => r.percentageCode === code)?.name ?? `IVA ${n(rate).toString()}%`;

    const rows: Record<string, ReportCell>[] = [];
    const push = (section: string, concept: string, base: Num | Dec, amount: Num | Dec) => rows.push({ section, concept, base: m2(base), amount: m2(amount) });
    for (const r of sales) push('Ventas (facturas − notas de crédito)', label(r.code, r.rate), r.base, r.amount);
    for (const r of purchases) push('Compras', label(r.code, r.rate), r.base, r.amount);
    for (const r of made) push(r.tax === '2' ? 'Retenciones de IVA efectuadas' : r.tax === '1' ? 'Retenciones de renta efectuadas' : 'Retenciones de ISD efectuadas', `Código ${r.code} (${n(r.percentage).toString()}%)`, r.base, r.amount);
    const recv = new Map<string, { base: Dec; amount: Dec }>();
    for (const mv of received) {
      for (const i of ((mv.data as { items?: { tax: string; code: string; percentage: string; base: string; amount: string }[] } | null)?.items ?? [])) {
        const k = `${i.tax}|${i.code}|${n(i.percentage).toString()}`;
        const acc = recv.get(k) ?? { base: new D(0), amount: new D(0) };
        recv.set(k, { base: acc.base.plus(i.base), amount: acc.amount.plus(i.amount) });
      }
    }
    for (const [k, v] of [...recv.entries()].sort()) {
      const [tax, code, p] = k.split('|');
      push(tax === '2' ? 'Retenciones de IVA que le hicieron' : 'Retenciones de renta que le hicieron', `Código ${code} (${p}%)`, v.base, v.amount);
    }
    const ivaSales = sales.reduce((a, r) => a.plus(n(r.amount)), new D(0));
    const ivaPurchases = purchases.reduce((a, r) => a.plus(n(r.amount)), new D(0));
    return {
      title: 'Resumen de IVA y retenciones',
      columns: [col('section', 'Sección'), col('concept', 'Concepto'), col('base', 'Base imponible', 'money'), col('amount', 'Impuesto / valor', 'money')],
      rows,
      totals: { section: 'IVA ventas − IVA compras', concept: null, base: null, amount: m2(ivaSales.minus(ivaPurchases)) },
      notes: [
        'Ayuda para preparar el formulario 104 y la declaración de retenciones: no reemplaza la revisión de su contador.',
        'Ventas por fecha de emisión (excluye comprobantes rechazados por el SRI). Compras por fecha de emisión del proveedor; el crédito tributario depende del sustento de cada compra.',
      ],
    };
  }
}

function sumRows(rows: Record<string, ReportCell>[], keys: string[], extra: Record<string, ReportCell>): Record<string, ReportCell> {
  const t: Record<string, ReportCell> = { ...extra };
  for (const k of keys) {
    const s = rows.reduce((a, r) => a.plus(r[k] === null || r[k] === undefined ? 0 : String(r[k])), new D(0));
    t[k] = Number(s.toDecimalPlaces(2).toString());
  }
  return t;
}
