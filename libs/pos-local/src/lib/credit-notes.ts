import { uuidv7 } from '@vektra/db/uuid';
import type { BuyerInput, CreditableInvoice, EDocStatusCode, TicketData } from '@vektra/shared-contracts';
import { creditNoteSchema } from '@vektra/shared-contracts';
import { validateCedula, validateRuc } from '@vektra/shared-domain';
import { buildAccessKey } from '@vektra/sri-core/access-key';
import { CalculationError, computeInvoice, creditLine, Totals } from '@vektra/sri-core/calc';
import { LocalUser, requirePerm } from './auth';
import { EngineContext } from './context';
import type { DocRow, StoredLine } from './sales';
import { D, ecuadorDate, formatSequential, json, m2, notFound, unprocessable } from './util';

interface NoteRow {
  id: string;
  sequential: number;
  number: string;
  access_key: string;
  issued_at: string;
  invoice_id: string;
  created_by: string | null;
  reason: string;
  refund_method: string;
  cash_movement_id: string | null;
  buyer: string;
  lines: string;
  totals: string;
  total: string;
  status: string;
  authorization_number: string | null;
  authorized_at: string | null;
  message: string | null;
}

export interface NoteLine {
  lineNo: number;
  productId: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  subtotal: string;
  percentageCode: string;
  /** Unidades base que vuelven al stock (0 si no reingresa) */
  restockQty: string;
}

const DEAD = ['NOT_AUTHORIZED', 'RETURNED', 'REJECTED_SYNC'];

/** Id de línea para facturas guardadas antes de la Fase 5 (determinístico a partir del documento). */
const legacyLineId = (docId: string, k: number) => `${docId.slice(0, 33)}${k.toString(16).padStart(3, '0')}`;

/**
 * Devoluciones en la caja de escritorio (también sin conexión): nota de crédito sobre una factura
 * emitida en esta caja, con el mismo cálculo que el servidor (`creditLine`: precio e IVA de la
 * factura, descuento prorrateado). El servidor genera el XML con el mismo secuencial y clave.
 */
export class LocalCreditNotes {
  constructor(private readonly ctx: EngineContext) {}

  private invoice(id: string): DocRow {
    const d = this.ctx.db.get<DocRow>('SELECT * FROM documents WHERE id = ?', id);
    if (!d) throw notFound('Factura no encontrada en esta caja (solo se pueden devolver ventas hechas aquí)');
    return d;
  }

  private lines(d: DocRow): (StoredLine & { lineId: string; lineNo: number })[] {
    return json<StoredLine[]>(d.lines, []).map((l, k) => ({ ...l, lineId: l.lineId ?? legacyLineId(d.id, k + 1), lineNo: l.lineNo ?? k + 1 }));
  }

  private notesOf(invoiceId: string): NoteRow[] {
    return this.ctx.db.all<NoteRow>('SELECT * FROM credit_notes WHERE invoice_id = ? ORDER BY sequential', invoiceId);
  }

  /** Cantidad y descuento ya acreditados por número de línea (notas vigentes). */
  private credited(invoiceId: string): Map<number, { quantity: InstanceType<typeof D>; discount: InstanceType<typeof D> }> {
    const out = new Map<number, { quantity: InstanceType<typeof D>; discount: InstanceType<typeof D> }>();
    for (const n of this.notesOf(invoiceId)) {
      if (DEAD.includes(n.status)) continue;
      for (const l of json<NoteLine[]>(n.lines, [])) {
        const c = out.get(l.lineNo) ?? { quantity: new D(0), discount: new D(0) };
        out.set(l.lineNo, { quantity: c.quantity.plus(l.quantity), discount: c.discount.plus(l.discount) });
      }
    }
    return out;
  }

  find(q: string): { id: string } {
    const term = q.trim();
    let d: { id: string } | undefined;
    if (/^\d{49}$/.test(term)) d = this.ctx.db.get<{ id: string }>('SELECT id FROM documents WHERE access_key = ?', term);
    else {
      const m = /^(\d{1,3})-(\d{1,3})-(\d{1,9})$/.exec(term);
      if (!m) throw unprocessable('Escriba el número de factura (ej. 001-002-000000123) o escanee la clave de acceso del ticket');
      const ep = this.ctx.requireConfig().emissionPoint;
      if (m[1].padStart(3, '0') !== ep.establishmentCode || m[2].padStart(3, '0') !== ep.code) {
        throw unprocessable(`Esta caja solo puede devolver sus propias ventas (${ep.establishmentCode}-${ep.code}). Para otras, use la web.`);
      }
      d = this.ctx.db.get<{ id: string }>('SELECT id FROM documents WHERE sequential = ?', Number(m[3]));
    }
    if (!d) throw notFound('No se encontró esa factura en esta caja');
    return d;
  }

  creditable(invoiceId: string): CreditableInvoice {
    const cfg = this.ctx.requireConfig();
    const d = this.invoice(invoiceId);
    const buyer = json<BuyerInput>(d.buyer, { idType: '07', id: '', name: '' });
    const credited = this.credited(d.id);
    const label = (code: string) => cfg.taxRates.find((r) => r.taxCode === '2' && r.percentageCode === code)?.label ?? code;
    const notes = this.notesOf(d.id);
    return {
      id: d.id,
      number: d.number,
      issueDate: d.issued_at.slice(0, 10),
      status: d.status as EDocStatusCode,
      buyer: { idType: buyer.idType, id: buyer.id, name: buyer.name, email: buyer.email ?? null, phone: buyer.phone ?? null, address: buyer.address ?? null },
      total: m2(d.total),
      credited: m2(notes.filter((n) => !DEAD.includes(n.status)).reduce((a, n) => a.plus(n.total), new D(0))),
      lines: this.lines(d).map((l) => {
        const c = credited.get(l.lineNo);
        return {
          id: l.lineId,
          mainCode: l.mainCode ?? null,
          description: l.description,
          quantity: new D(l.quantity).toString(),
          unitPrice: l.unitPrice,
          discount: m2(l.discount),
          subtotal: m2(l.subtotal),
          taxLabel: label(l.percentageCode),
          taxRate: l.rate ?? cfg.taxRates.find((r) => r.taxCode === '2' && r.percentageCode === l.percentageCode)?.rate ?? '0',
          productId: l.productId,
          credited: (c?.quantity ?? new D(0)).toString(),
          creditedDiscount: m2(c?.discount ?? 0),
          remaining: new D(l.quantity).minus(c?.quantity ?? 0).toString(),
        };
      }),
      creditNotes: notes.map((n) => ({ id: n.id, number: n.number, total: m2(n.total), status: n.status as EDocStatusCode, reason: n.reason, issueDate: n.issued_at.slice(0, 10) })),
    };
  }

  issue(user: LocalUser, body: unknown): { documentId: string; number: string; accessKey: string; total: string } {
    requirePerm(user, 'sales.void');
    const parsed = creditNoteSchema.safeParse(body);
    if (!parsed.success) throw unprocessable('Revise la devolución', parsed.error.issues.map((i) => i.message));
    const input = parsed.data;
    this.ctx.assertCanIssue();
    const cfg = this.ctx.requireConfig();
    const ep = cfg.emissionPoint;
    if (input.emissionPointId !== ep.id) throw unprocessable('Esta caja solo emite en su propio punto de emisión');
    const inv = this.invoice(input.invoiceId);
    if (DEAD.includes(inv.status)) throw unprocessable('La factura no fue autorizada: no se le puede emitir nota de crédito');

    const invBuyer = json<BuyerInput>(inv.buyer, { idType: '07', id: '', name: '' });
    const buyer = invBuyer.idType === '07' ? input.buyer : { ...invBuyer, email: input.buyer?.email ?? invBuyer.email };
    if (!buyer) throw unprocessable('La venta fue a consumidor final: para la nota de crédito ingrese la cédula o RUC del cliente');
    if (buyer.idType === '07') throw unprocessable('La nota de crédito debe identificar al cliente');
    if (buyer.idType === '04' && !validateRuc(buyer.id).valid) throw unprocessable(`RUC inválido: ${validateRuc(buyer.id).error}`);
    if (buyer.idType === '05' && !validateCedula(buyer.id).valid) throw unprocessable(`Cédula inválida: ${validateCedula(buyer.id).error}`);

    const srcLines = this.lines(inv);
    const credited = this.credited(inv.id);
    const seen = new Set<string>();
    const picked = input.lines.map((sel) => {
      const src = srcLines.find((l) => l.lineId === sel.sourceLineId);
      if (!src) throw unprocessable('Una de las líneas no pertenece a la factura');
      if (seen.has(src.lineId)) throw unprocessable(`"${src.description}" está repetida`);
      seen.add(src.lineId);
      return { sel, src };
    });

    let computed;
    try {
      computed = computeInvoice(
        picked.map(({ sel, src }) => {
          const c = credited.get(src.lineNo);
          const rate = src.rate ?? cfg.taxRates.find((r) => r.taxCode === '2' && r.percentageCode === src.percentageCode)?.rate ?? '0';
          return creditLine(
            {
              mainCode: src.mainCode,
              auxCode: src.auxCode,
              description: src.description,
              quantity: src.quantity,
              unitPrice: src.unitPrice,
              discount: src.discount,
              taxes: [{ taxCode: src.taxCode ?? '2', percentageCode: src.percentageCode, rate }],
              creditedQuantity: (c?.quantity ?? new D(0)).toString(),
              creditedDiscount: (c?.discount ?? new D(0)).toString(),
            },
            sel.quantity,
          );
        }),
      );
    } catch (e) {
      if (e instanceof CalculationError) throw unprocessable(e.message);
      throw e;
    }

    const method = cfg.paymentMethods.find((m) => m.method === input.refund.method);
    let sessionId: string | null = null;
    if (method?.cash && input.refund.cashSessionId) {
      const s = this.ctx.db.get<{ status: string }>('SELECT status FROM cash_sessions WHERE id = ?', input.refund.cashSessionId);
      if (!s || s.status !== 'OPEN') throw unprocessable('La caja está cerrada: abra la caja para devolver el efectivo');
      sessionId = input.refund.cashSessionId;
    }

    const issuedAt = this.ctx.now();
    const issueDate = ecuadorDate(issuedAt);
    const id = uuidv7();
    const noteLines: NoteLine[] = computed.lines.map((l, k) => {
      const { sel, src } = picked[k];
      const factor = new D(src.baseQty).div(src.quantity || 1);
      return {
        lineNo: src.lineNo,
        productId: src.productId,
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        discount: l.discount,
        subtotal: l.subtotal,
        percentageCode: l.taxes[0]?.percentageCode ?? '',
        restockQty: sel.restock && src.productId ? new D(l.quantity).times(factor).toString() : '0',
      };
    });

    return this.ctx.db.tx(() => {
      const sequential = this.ctx.nextSequential('04');
      const accessKey = buildAccessKey({
        issueDate,
        docType: '04',
        ruc: cfg.company.ruc,
        environment: cfg.company.environment === 2 ? 2 : 1,
        establishment: ep.establishmentCode,
        emissionPoint: ep.code,
        sequential,
      });
      const number = `${ep.establishmentCode}-${ep.code}-${formatSequential(sequential)}`;
      const cashMovementId = sessionId ? uuidv7() : null;
      this.ctx.db.run(
        `INSERT INTO credit_notes (id, sequential, number, access_key, issued_at, invoice_id, created_by, reason, refund_method, cash_movement_id, buyer, lines, totals, total, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_SYNC')`,
        id,
        sequential,
        number,
        accessKey,
        issuedAt.toISOString(),
        inv.id,
        user.id,
        input.reason,
        input.refund.method,
        cashMovementId,
        JSON.stringify(buyer),
        JSON.stringify(noteLines),
        JSON.stringify(computed.totals),
        computed.totals.total,
      );
      if (sessionId && cashMovementId) {
        this.ctx.db.run(
          "INSERT INTO cash_movements (id, session_id, type, amount, reason, created_by, at, document_id) VALUES (?, ?, 'OUT', ?, ?, ?, ?, ?)",
          cashMovementId,
          sessionId,
          computed.totals.total,
          `Devolución NC ${number} (factura ${inv.number})`,
          user.id,
          issuedAt.toISOString(),
          id,
        );
      }
      this.ctx.enqueue(
        'credit_note.issue',
        {
          documentId: id,
          issuedAt: issuedAt.toISOString(),
          sequential,
          accessKey,
          cashMovementId,
          request: {
            invoiceId: inv.id,
            emissionPointId: ep.id,
            reason: input.reason,
            buyer: invBuyer.idType === '07' ? buyer : null,
            lines: picked.map(({ sel, src }) => ({ lineNo: src.lineNo, quantity: new D(sel.quantity).toString(), restock: sel.restock })),
            refund: { method: input.refund.method, cashSessionId: sessionId },
          },
        },
        user.id,
      );
      return { documentId: id, number, accessKey, total: computed.totals.total };
    });
  }

  has(id: string): boolean {
    return !!this.ctx.db.get('SELECT 1 FROM credit_notes WHERE id = ?', id);
  }

  detail(id: string) {
    const n = this.ctx.db.get<NoteRow>('SELECT * FROM credit_notes WHERE id = ?', id);
    if (!n) throw notFound('Comprobante no encontrado');
    return { id: n.id, number: n.number, accessKey: n.access_key, status: n.status, total: n.total, authorizationNumber: n.authorization_number, authorizedAt: n.authorized_at };
  }

  /** Ticket térmico de la nota de crédito (mismo formato que la factura). */
  ticket(id: string, base: (doc: DocRow) => TicketData): TicketData {
    const n = this.ctx.db.get<NoteRow>('SELECT * FROM credit_notes WHERE id = ?', id);
    if (!n) throw notFound('Comprobante no encontrado');
    const inv = this.invoice(n.invoice_id);
    const totals = json<Totals>(n.totals, { subtotal: '0', totalDiscount: '0', taxGroups: [], totalTax: '0', tip: '0', total: n.total });
    const asDoc: DocRow = {
      ...inv,
      id: n.id,
      number: n.number,
      access_key: n.access_key,
      issued_at: n.issued_at,
      created_by: n.created_by,
      buyer: n.buyer,
      lines: n.lines,
      totals: JSON.stringify(totals),
      payments: JSON.stringify([{ method: n.refund_method, sriCode: '', amount: n.total, cashReceived: null, reference: null }]),
      total: n.total,
      status: n.status,
    };
    return {
      ...base(asDoc),
      docLabel: 'NOTA DE CRÉDITO',
      related: { label: 'FACTURA', number: inv.number, date: inv.issued_at.slice(0, 10) },
      reason: n.reason,
    };
  }
}
