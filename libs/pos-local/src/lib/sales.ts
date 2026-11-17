import { uuidv7 } from '@vektra/db/uuid';
import type { BuyerInput, IssueInvoiceParsed, QuoteView, TicketData } from '@vektra/shared-contracts';
import { issueInvoiceSchema, quoteSchema } from '@vektra/shared-contracts';
import { validateCedula, validateRuc } from '@vektra/shared-domain';
import { buildAccessKey } from '@vektra/sri-core/access-key';
import { assertPaymentsMatch, CalculationError, computeInvoice, Totals } from '@vektra/sri-core/calc';
import { createHmac } from 'node:crypto';
import { LocalUser, requirePerm } from './auth';
import { LocalCatalog } from './catalog';
import { EngineContext } from './context';
import { D, ecuadorDate, forbidden, formatSequential, json, m2, notFound, unprocessable } from './util';

export interface DocRow {
  id: string;
  sequential: number;
  number: string;
  access_key: string;
  issued_at: string;
  cash_session_id: string | null;
  created_by: string | null;
  quote_id: string | null;
  buyer: string;
  lines: string;
  totals: string;
  payments: string;
  total: string;
  status: string;
  authorization_number: string | null;
  authorized_at: string | null;
  message: string | null;
}

export interface StoredLine {
  /** Id local de la línea (para devoluciones) y su número en la factura */
  lineId?: string;
  lineNo?: number;
  mainCode?: string | null;
  auxCode?: string | null;
  taxCode?: string;
  rate?: string;
  productId: string | null;
  baseQty: string;
  description: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  subtotal: string;
  percentageCode: string;
}

export interface StoredPayment {
  method: string;
  sriCode: string;
  amount: string;
  cashReceived: string | null;
  reference: string | null;
}

function validateBuyer(b: BuyerInput, finalConsumerId: string): void {
  if (b.idType === '07') {
    if (b.id !== finalConsumerId) throw unprocessable(`Para consumidor final la identificación es ${finalConsumerId}`);
    return;
  }
  if (b.id === finalConsumerId) throw unprocessable('La identificación 9999999999999 solo se usa con el tipo "Consumidor final"');
  if (b.idType === '04' && !validateRuc(b.id).valid) throw unprocessable(`RUC del cliente inválido: ${validateRuc(b.id).error}`);
  if (b.idType === '05' && !validateCedula(b.id).valid) throw unprocessable(`Cédula del cliente inválida: ${validateCedula(b.id).error}`);
}

/**
 * Ventas de la caja sin depender del servidor. Aplica las mismas validaciones que la emisión en
 * línea, asigna el secuencial del punto de emisión propio de la caja y la clave de acceso, y deja
 * la factura en la cola. El servidor genera el XML con esos mismos datos, lo firma y lo envía al SRI.
 */
export class LocalSales {
  constructor(
    private readonly ctx: EngineContext,
    private readonly catalog: LocalCatalog,
  ) {}

  issue(user: LocalUser, body: unknown): { documentId: string; number: string; accessKey: string; total: string } {
    requirePerm(user, 'sales.create');
    const parsed = issueInvoiceSchema.safeParse(body);
    if (!parsed.success) throw unprocessable('Revise los datos de la factura', parsed.error.issues.map((i) => i.message));
    const input: IssueInvoiceParsed = parsed.data;
    if (input.lines.some((l) => l.discount && Number(l.discount) > 0) && !user.permissions.has('sales.discount')) {
      throw forbidden('No tiene permiso para aplicar descuentos');
    }
    this.ctx.assertCanIssue();
    const cfg = this.ctx.requireConfig();
    const ep = cfg.emissionPoint;
    if (input.emissionPointId !== ep.id) throw unprocessable('Esta caja solo factura en su propio punto de emisión');

    const issuedAt = this.ctx.now();
    const issueDate = ecuadorDate(issuedAt);
    const day = `${issueDate.year}-${String(issueDate.month).padStart(2, '0')}-${String(issueDate.day).padStart(2, '0')}`;
    const rateById = new Map(cfg.taxRates.map((r) => [r.id, r]));
    for (const l of input.lines) {
      const r = rateById.get(l.taxRateId);
      if (!r || !r.active || (r.validFrom && r.validFrom > day) || (r.validTo && r.validTo < day)) {
        throw unprocessable('Una de las tarifas de impuesto seleccionadas no está vigente');
      }
    }
    validateBuyer(input.buyer, cfg.finalConsumer.id);

    if (input.cashSessionId) {
      const s = this.ctx.db.get<{ status: string }>('SELECT status FROM cash_sessions WHERE id = ?', input.cashSessionId);
      if (!s || s.status !== 'OPEN') throw unprocessable('La caja está cerrada. Abra la caja para seguir vendiendo.');
    }
    const methodDefs = new Map(cfg.paymentMethods.map((m) => [m.method, m]));
    const payments: StoredPayment[] = input.payments.map((p) => {
      const def = methodDefs.get(p.method);
      if (def?.credit && input.buyer.idType === '07') throw unprocessable('Las ventas a crédito requieren un cliente identificado');
      return { method: p.method, sriCode: def?.sriCode ?? p.sriCode, amount: m2(p.amount), cashReceived: p.cashReceived ? m2(p.cashReceived) : null, reference: p.reference ?? null };
    });
    if (input.quoteId) {
      const q = this.ctx.db.get<{ document_id: string | null }>('SELECT document_id FROM quotes WHERE id = ?', input.quoteId);
      if (!q) throw unprocessable('Proforma no encontrada');
      if (q.document_id) throw unprocessable('Esta proforma ya fue facturada');
    }

    // Factor de cada presentación (para el stock en unidades base)
    const factors = input.lines.map((l, i) => {
      if (!l.productId) return '1';
      const p = this.ctx.db.get<{ active: number; is_service: number }>('SELECT active, is_service FROM products WHERE id = ?', l.productId);
      if (!p || !p.active) throw unprocessable(`Línea ${i + 1}: el producto no existe o está inactivo`);
      if (!l.productUnitId) return '1';
      const pu = this.ctx.db.get<{ factor: string }>('SELECT factor FROM product_units WHERE id = ? AND product_id = ?', l.productUnitId, l.productId);
      if (!pu) throw unprocessable(`Línea ${i + 1}: la presentación no corresponde al producto`);
      return pu.factor;
    });

    let computed;
    try {
      computed = computeInvoice(
        input.lines.map((l) => {
          const r = rateById.get(l.taxRateId)!;
          return {
            mainCode: l.mainCode,
            auxCode: l.auxCode,
            description: l.description,
            unit: l.unit,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            discount: l.discount ?? '0',
            taxes: [{ taxCode: r.taxCode, percentageCode: r.percentageCode, rate: r.rate }],
            additional: l.additional,
          };
        }),
        { tip: input.tip ?? '0' },
      );
      assertPaymentsMatch(payments, computed.totals.total);
    } catch (e) {
      if (e instanceof CalculationError) throw unprocessable(e.message);
      throw e;
    }
    if (input.buyer.idType === '07' && new D(computed.totals.total).gt(cfg.finalConsumer.maxAmount)) {
      throw unprocessable(`Las facturas a consumidor final no pueden superar $${cfg.finalConsumer.maxAmount}. Identifique al cliente con cédula o RUC.`);
    }

    const lines: StoredLine[] = computed.lines.map((l, k) => ({
      lineId: uuidv7(),
      lineNo: k + 1,
      mainCode: l.mainCode,
      auxCode: l.auxCode,
      taxCode: l.taxes[0]?.taxCode ?? '2',
      rate: l.taxes[0]?.rate ?? '0',
      productId: input.lines[k].productId ?? null,
      baseQty: new D(l.quantity).times(factors[k]).toString(),
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discount: l.discount,
      subtotal: l.subtotal,
      percentageCode: l.taxes[0]?.percentageCode ?? '',
    }));

    if (!cfg.company.allowNegativeStock) {
      const need = new Map<string, InstanceType<typeof D>>();
      for (const l of lines) if (l.productId) need.set(l.productId, (need.get(l.productId) ?? new D(0)).plus(l.baseQty));
      const services = new Set(
        this.ctx.db.all<{ id: string }>(`SELECT id FROM products WHERE is_service = 1 AND id IN (${[...need.keys()].map(() => '?').join(',') || "''"})`, ...need.keys()).map((r) => r.id),
      );
      const available = this.catalog.availableStock([...need.keys()]);
      for (const [pid, q] of need) {
        if (services.has(pid)) continue;
        if (new D(available.get(pid) ?? 0).lt(q)) {
          const name = this.ctx.db.get<{ name: string }>('SELECT name FROM products WHERE id = ?', pid)?.name ?? '';
          throw unprocessable(`Stock insuficiente de "${name}": disponible ${available.get(pid) ?? 0}`);
        }
      }
    }

    const buyerName = input.buyer.idType === '07' ? cfg.finalConsumer.name : input.buyer.name;
    const documentId = uuidv7();
    return this.ctx.db.tx(() => {
      const sequential = this.ctx.nextSequential('01');
      const accessKey = buildAccessKey({
        issueDate,
        docType: '01',
        ruc: cfg.company.ruc,
        environment: cfg.company.environment === 2 ? 2 : 1,
        establishment: ep.establishmentCode,
        emissionPoint: ep.code,
        sequential,
      });
      const number = `${ep.establishmentCode}-${ep.code}-${formatSequential(sequential)}`;
      this.ctx.db.run(
        `INSERT INTO documents (id, sequential, number, access_key, issued_at, cash_session_id, created_by, quote_id, buyer, lines, totals, payments, total, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_SYNC')`,
        documentId,
        sequential,
        number,
        accessKey,
        issuedAt.toISOString(),
        input.cashSessionId ?? null,
        user.id,
        input.quoteId ?? null,
        JSON.stringify({ ...input.buyer, name: buyerName }),
        JSON.stringify(lines),
        JSON.stringify(computed.totals),
        JSON.stringify(payments),
        computed.totals.total,
      );
      if (input.quoteId) this.ctx.db.run('UPDATE quotes SET document_id = ? WHERE id = ?', documentId, input.quoteId);
      this.ctx.enqueue('invoice.issue', { documentId, issuedAt: issuedAt.toISOString(), sequential, accessKey, request: input }, user.id);
      return { documentId, number, accessKey, total: computed.totals.total };
    });
  }

  private doc(id: string): DocRow {
    const d = this.ctx.db.get<DocRow>('SELECT * FROM documents WHERE id = ?', id);
    if (!d) throw notFound('Comprobante no encontrado');
    return d;
  }

  /** Detalle mínimo (la pantalla de venta consulta el estado SRI). */
  detail(id: string) {
    const d = this.doc(id);
    const buyer = json<BuyerInput>(d.buyer, { idType: '07', id: '', name: '' });
    return {
      id: d.id,
      number: d.number,
      accessKey: d.access_key,
      status: d.status,
      total: d.total,
      issueDate: d.issued_at.slice(0, 10),
      buyerName: buyer.name,
      buyerId: buyer.id,
      authorizationNumber: d.authorization_number,
      authorizedAt: d.authorized_at,
      messages: d.message ? [{ identifier: '', message: d.message, additionalInfo: null, type: 'ERROR', explanation: null }] : [],
    };
  }

  /** Enlace público firmado con la llave de la caja (el servidor lo verifica sin guardarla). */
  publicRideUrl(documentId: string): string {
    const cfg = this.ctx.requireConfig();
    const { tenantId, deviceId, linkKey, publicBaseUrl } = cfg.link;
    const sig = createHmac('sha256', Buffer.from(linkKey, 'base64url')).update(`${tenantId}.${documentId}`).digest('base64url').slice(0, 32);
    const token = `${Buffer.from(`${tenantId}.${documentId}.${deviceId}`).toString('base64url')}.${sig}`;
    return `${publicBaseUrl.replace(/\/$/, '')}/api/public/documents/${token}/ride`;
  }

  ticket(id: string): TicketData {
    return this.ticketFromRow(this.doc(id));
  }

  ticketFromRow(d: DocRow): TicketData {
    const cfg = this.ctx.requireConfig();
    const buyer = json<BuyerInput>(d.buyer, { idType: '07', id: '', name: '' });
    const totals = json<Totals>(d.totals, { subtotal: '0', totalDiscount: '0', taxGroups: [], totalTax: '0', tip: '0', total: d.total });
    const label = (code: string) => cfg.taxRates.find((r) => r.taxCode === '2' && r.percentageCode === code)?.label ?? code;
    const methodLabel = (m: string) => cfg.paymentMethods.find((x) => x.method === m)?.label ?? m;
    const cashier = d.created_by ? (this.ctx.db.get<{ full_name: string }>('SELECT full_name FROM users WHERE id = ?', d.created_by)?.full_name ?? null) : null;
    return {
      documentId: d.id,
      company: {
        legalName: cfg.company.legalName,
        tradeName: cfg.company.tradeName,
        ruc: cfg.company.ruc,
        mainAddress: cfg.company.mainAddress,
        establishmentAddress: cfg.emissionPoint.establishmentAddress,
        keepsAccounting: cfg.company.keepsAccounting,
        specialTaxpayerNumber: cfg.company.specialTaxpayerNumber,
        withholdingAgentNumber: cfg.company.withholdingAgentNumber,
        rimpeLegend: cfg.company.rimpeLegend,
        logoBase64: cfg.company.logoBase64,
      },
      number: d.number,
      accessKey: d.access_key,
      environment: cfg.company.environment,
      status: d.status,
      issuedAt: d.issued_at,
      buyer: { idType: buyer.idType, id: buyer.id, name: buyer.name, address: buyer.address ?? null, email: buyer.email ?? null },
      lines: json<StoredLine[]>(d.lines, []).map((l) => ({
        description: l.description,
        quantity: new D(l.quantity).toString(),
        unitPrice: new D(l.unitPrice).toDecimalPlaces(4).toString(),
        discount: l.discount,
        subtotal: l.subtotal,
        taxLabel: label(l.percentageCode),
      })),
      taxSummary: totals.taxGroups.map((g) => ({ label: label(g.percentageCode), base: g.base, amount: g.amount })),
      subtotal: totals.subtotal,
      totalDiscount: totals.totalDiscount,
      totalTax: totals.totalTax,
      total: totals.total,
      payments: json<StoredPayment[]>(d.payments, []).map((p) => ({
        label: methodLabel(p.method),
        amount: m2(p.amount),
        cashReceived: p.cashReceived,
        change: p.cashReceived ? D.max(0, new D(p.cashReceived).minus(p.amount)).toFixed(2) : null,
      })),
      cashier,
      publicRideUrl: this.publicRideUrl(d.id),
      buyerPhone: buyer.phone ?? null,
    };
  }

  /** Correo con XML y RIDE: lo envía el servidor cuando el SRI autorice. */
  email(user: LocalUser, id: string, email?: string): void {
    requirePerm(user, 'sales.create');
    this.doc(id);
    this.ctx.db.tx(() => this.ctx.enqueue('document.email', { documentId: id, email: email ?? null }, user.id));
  }

  // ───────── Proformas ─────────

  createQuote(user: LocalUser, body: unknown): QuoteView {
    requirePerm(user, 'sales.quote');
    const parsed = quoteSchema.safeParse(body);
    if (!parsed.success) throw unprocessable('Revise la proforma', parsed.error.issues.map((i) => i.message));
    const input = parsed.data;
    const cfg = this.ctx.requireConfig();
    let total: string;
    try {
      total = computeInvoice(
        input.lines.map((l) => {
          const r = cfg.taxRates.find((x) => x.id === l.taxRateId);
          if (!r) throw new CalculationError('Tarifa no encontrada');
          return { description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, discount: l.discount, taxes: [{ taxCode: r.taxCode, percentageCode: r.percentageCode, rate: r.rate }] };
        }),
      ).totals.total;
    } catch (e) {
      throw unprocessable((e as Error).message);
    }
    const id = uuidv7();
    const createdAt = this.ctx.now();
    const validUntil = new Date(createdAt);
    validUntil.setUTCDate(validUntil.getUTCDate() + input.validDays);
    this.ctx.db.tx(() => {
      const number = this.ctx.nextSequential('PF');
      this.ctx.db.run(
        'INSERT INTO quotes (id, number, created_at, created_by, request, total, valid_until) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id,
        number,
        createdAt.toISOString(),
        user.id,
        JSON.stringify(input),
        total,
        validUntil.toISOString().slice(0, 10),
      );
      this.ctx.enqueue('quote.create', { id, number, createdAt: createdAt.toISOString(), request: input }, user.id);
    });
    return this.quote(id);
  }

  quote(id: string): QuoteView {
    const r = this.ctx.db.get<{ id: string; number: number; created_at: string; request: string; total: string; valid_until: string; document_id: string | null }>(
      'SELECT * FROM quotes WHERE id = ?',
      id,
    );
    if (!r) throw notFound('Proforma no encontrada');
    const q = json<ReturnType<typeof quoteSchema.parse>>(r.request, null as never);
    const today = ecuadorDate(this.ctx.now());
    const todayStr = `${today.year}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`;
    return {
      id: r.id,
      number: formatSequential(r.number),
      emissionPointId: q.emissionPointId,
      buyerIdType: q.buyer.idType,
      buyerId: q.buyer.id,
      buyerName: q.buyer.name,
      buyerEmail: q.buyer.email ?? null,
      priceListId: q.priceListId ?? null,
      lines: q.lines,
      total: m2(r.total),
      validUntil: r.valid_until,
      notes: q.notes ?? null,
      documentId: r.document_id,
      createdAt: r.created_at,
      expired: r.valid_until < todayStr,
    };
  }

  quotes(search: string): { total: number; page: number; pageSize: number; items: QuoteView[] } {
    const rows = this.ctx.db.all<{ id: string; request: string }>('SELECT id, request FROM quotes WHERE document_id IS NULL ORDER BY created_at DESC LIMIT 200');
    const s = search.trim().toLowerCase();
    const items = rows
      .filter((r) => !s || r.request.toLowerCase().includes(s))
      .slice(0, 50)
      .map((r) => this.quote(r.id));
    return { total: items.length, page: 1, pageSize: 50, items };
  }
}
