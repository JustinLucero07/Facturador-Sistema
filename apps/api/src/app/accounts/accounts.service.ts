import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { AccountsError, agingBucket, applyCredit, createItem, D, daysOverdue, partyBalance, recordMovement, Side, voidMovement } from '@vektra/accounts';
import { Tx, uuidv7 } from '@vektra/db';
import { loadSriSettings } from '@vektra/einvoice';
import type {
  AccountPaymentParsed,
  AccountsOverview,
  AccountStatement,
  AgingBuckets,
  PartyAccountSummary,
  ReceivedWithholdingParsed,
  ReceivedWithholdingPreview,
} from '@vektra/shared-contracts';
import { parseWithholdingXml } from '@vektra/sri-core';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../common/prisma.service';
import { currentContext } from '../common/request-context';

const m2 = (v: string | number | InstanceType<typeof D>) => new D(v).toDecimalPlaces(2).toFixed(2);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const asDay = (s: string) => new Date(`${s}T00:00:00Z`);
const emptyBuckets = () => ({ current: new D(0), d30: new D(0), d60: new D(0), d90: new D(0), over90: new D(0) });
const fmtBuckets = (b: ReturnType<typeof emptyBuckets>): AgingBuckets => ({ current: m2(b.current), d30: m2(b.d30), d60: m2(b.d60), d90: m2(b.d90), over90: m2(b.over90) });

/** Convierte los errores del libro en mensajes 422. */
function wrap<T>(p: Promise<T>): Promise<T> {
  return p.catch((e) => {
    if (e instanceof AccountsError) throw new UnprocessableEntityException(e.message);
    throw e;
  });
}

/**
 * Cuentas por cobrar (AR) y por pagar (AP): saldos por tercero con antigüedad, estado de cuenta,
 * cobros/pagos (en efectivo entran o salen de la caja abierta), retenciones recibidas, saldos
 * iniciales y saldo a favor.
 */
@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private ctx() {
    const c = currentContext();
    return { tenantId: c.tenantId as string, userId: c.userId as string };
  }

  async overview(side: Side, q: { search?: string; page: number; pageSize: number; overdueOnly?: boolean }): Promise<AccountsOverview> {
    const today = new Date();
    const { items, credits, parties } = await this.prisma.tx(async (tx) => {
      const items = await tx.accountItem.findMany({ where: { side, status: 'OPEN' }, select: { partyId: true, balance: true, dueDate: true } });
      const credits = await tx.accountMovement.groupBy({ by: ['partyId'], where: { side, voidedAt: null, unapplied: { gt: 0 } }, _sum: { unapplied: true } });
      const ids = [...new Set([...items.map((i) => i.partyId), ...credits.map((c) => c.partyId)])];
      const parties = await tx.party.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, identification: true, creditLimit: true } });
      return { items, credits, parties };
    });
    const byParty = new Map<string, { owed: InstanceType<typeof D>; overdue: InstanceType<typeof D>; open: number; oldest: Date | null; b: ReturnType<typeof emptyBuckets> }>();
    const totals = emptyBuckets();
    for (const i of items) {
      const cur = byParty.get(i.partyId) ?? { owed: new D(0), overdue: new D(0), open: 0, oldest: null, b: emptyBuckets() };
      const bal = new D(i.balance.toString());
      const bucket = agingBucket(i.dueDate, today);
      cur.owed = cur.owed.plus(bal);
      if (bucket !== 'current') cur.overdue = cur.overdue.plus(bal);
      cur.b[bucket] = cur.b[bucket].plus(bal);
      totals[bucket] = totals[bucket].plus(bal);
      cur.open++;
      if (!cur.oldest || i.dueDate < cur.oldest) cur.oldest = i.dueDate;
      byParty.set(i.partyId, cur);
    }
    const creditOf = new Map(credits.map((c) => [c.partyId, new D(c._sum.unapplied?.toString() ?? 0)]));
    const s = q.search?.trim().toLowerCase();
    let rows: PartyAccountSummary[] = parties
      .map((p) => {
        const a = byParty.get(p.id) ?? { owed: new D(0), overdue: new D(0), open: 0, oldest: null, b: emptyBuckets() };
        return {
          partyId: p.id,
          name: p.name,
          identification: p.identification,
          owed: m2(a.owed),
          overdue: m2(a.overdue),
          credit: m2(creditOf.get(p.id) ?? 0),
          creditLimit: p.creditLimit.toFixed(2),
          openItems: a.open,
          oldestDue: a.oldest ? iso(a.oldest) : null,
          buckets: fmtBuckets(a.b),
        };
      })
      .filter((r) => !s || r.name.toLowerCase().includes(s) || r.identification.includes(s))
      .filter((r) => !q.overdueOnly || Number(r.overdue) > 0)
      .sort((a, b) => Number(b.overdue) - Number(a.overdue) || Number(b.owed) - Number(a.owed));
    const owed = rows.reduce((a, r) => a.plus(r.owed), new D(0));
    const overdue = rows.reduce((a, r) => a.plus(r.overdue), new D(0));
    const credit = rows.reduce((a, r) => a.plus(r.credit), new D(0));
    const total = rows.length;
    rows = rows.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
    return { totals: { owed: m2(owed), overdue: m2(overdue), credit: m2(credit), buckets: fmtBuckets(totals), parties: total }, total, page: q.page, pageSize: q.pageSize, items: rows };
  }

  async statement(side: Side, partyId: string): Promise<AccountStatement> {
    const today = new Date();
    const data = await this.prisma.tx(async (tx) => {
      const party = await tx.party.findFirst({ where: { id: partyId } });
      if (!party) throw new NotFoundException('Cliente o proveedor no encontrado');
      const items = await tx.accountItem.findMany({ where: { side, partyId }, orderBy: [{ status: 'asc' }, { dueDate: 'asc' }], take: 500 });
      const movements = await tx.accountMovement.findMany({ where: { side, partyId }, orderBy: { date: 'desc' }, include: { allocations: true }, take: 500 });
      const bal = await partyBalance(tx, side, partyId, today);
      return { party, items, movements, bal };
    });
    const numberOf = new Map(data.items.map((i) => [i.id, i.number]));
    const b = emptyBuckets();
    for (const i of data.items.filter((x) => x.status === 'OPEN')) b[agingBucket(i.dueDate, today)] = b[agingBucket(i.dueDate, today)].plus(i.balance.toString());
    const limit = new D(data.party.creditLimit.toString());
    return {
      side,
      party: {
        id: data.party.id,
        name: data.party.name,
        identification: data.party.identification,
        email: data.party.email,
        phone: data.party.phone,
        creditLimit: limit.toFixed(2),
        creditDays: data.party.creditDays,
      },
      owed: data.bal.owed,
      overdue: data.bal.overdue,
      credit: data.bal.credit,
      available: side === 'AR' && limit.gt(0) ? m2(D.max(0, limit.minus(data.bal.owed))) : null,
      buckets: fmtBuckets(b),
      items: data.items.map((i) => ({
        id: i.id,
        number: i.number,
        sourceType: i.sourceType as 'INVOICE' | 'PURCHASE' | 'OPENING',
        sourceId: i.sourceId,
        issueDate: iso(i.issueDate),
        dueDate: iso(i.dueDate),
        amount: i.amount.toFixed(2),
        balance: i.balance.toFixed(2),
        status: i.status as 'OPEN' | 'PAID' | 'VOID',
        daysOverdue: i.status === 'OPEN' ? daysOverdue(i.dueDate, today) : 0,
        notes: i.notes,
      })),
      movements: data.movements.map((m) => ({
        id: m.id,
        kind: m.kind as 'PAYMENT' | 'WITHHOLDING' | 'CREDIT_NOTE' | 'ADVANCE',
        date: iso(m.date),
        method: m.method,
        amount: m.amount.toFixed(2),
        unapplied: m.unapplied.toFixed(2),
        reference: m.reference,
        documentId: m.documentId,
        notes: m.notes,
        voided: !!m.voidedAt,
        voidReason: m.voidReason,
        allocations: m.allocations.map((a) => ({ itemId: a.itemId, number: numberOf.get(a.itemId) ?? '', amount: a.amount.toFixed(2) })),
      })),
    };
  }

  /** Movimiento de caja del cobro (entra) o del pago (sale) en efectivo. */
  private async cashMovement(tx: Tx, tenantId: string, userId: string, side: Side, sessionId: string | null | undefined, method: string, amount: string, reason: string): Promise<string | null> {
    const def = (await loadSriSettings(this.prisma.client)).paymentMethods.find((m) => m.method === method);
    if (!def || def.credit) throw new UnprocessableEntityException('Medio de pago inválido');
    if (!def.cash || !sessionId) return null;
    const s = await tx.cashSession.findFirst({ where: { id: sessionId } });
    if (!s || s.status !== 'OPEN') throw new UnprocessableEntityException('La caja está cerrada: abra la caja para registrar el efectivo');
    const id = uuidv7();
    await tx.cashMovement.create({ data: { id, tenantId, sessionId: s.id, type: side === 'AR' ? 'IN' : 'OUT', amount, reason, createdBy: userId } });
    return id;
  }

  async registerPayment(side: Side, input: AccountPaymentParsed): Promise<{ id: string; unapplied: string }> {
    const { tenantId, userId } = this.ctx();
    return wrap(
      this.prisma.tx(async (tx) => {
        const party = await tx.party.findFirst({ where: { id: input.partyId } });
        if (!party) throw new NotFoundException('Cliente o proveedor no encontrado');
        const label = side === 'AR' ? `Cobro a ${party.name}` : `Pago a ${party.name}`;
        const cashMovementId = await this.cashMovement(tx, tenantId, userId, side, input.cashSessionId, input.method, input.amount, label);
        const res = await recordMovement(tx, {
          tenantId,
          side,
          partyId: party.id,
          kind: input.kind,
          date: asDay(input.date),
          amount: input.amount,
          method: input.method,
          reference: input.reference ?? null,
          notes: input.notes ?? null,
          cashMovementId,
          userId,
          allocations: input.kind === 'ADVANCE' ? 'none' : input.allocations?.length ? input.allocations : 'auto',
        });
        await this.audit.record(tx, {
          action: side === 'AR' ? 'receivable.payment' : 'payable.payment',
          entity: 'account_movement',
          entityId: res.id,
          after: { partyId: party.id, amount: input.amount, method: input.method, kind: input.kind, unapplied: res.unapplied },
        });
        return res;
      }),
    );
  }

  /** Lee el XML de una retención que le hizo un cliente y busca la factura retenida. */
  async receivedWithholdingPreview(xml: string): Promise<ReceivedWithholdingPreview> {
    const { tenantId } = this.ctx();
    let w;
    try {
      w = parseWithholdingXml(xml);
    } catch {
      throw new UnprocessableEntityException('El archivo no es un comprobante de retención XML del SRI');
    }
    const tenant = await this.prisma.client.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const warnings: string[] = [];
    if (w.subject.id !== tenant.ruc) warnings.push(`La retención está emitida a ${w.subject.name} (${w.subject.id}), no a esta empresa (${tenant.ruc}).`);
    const pad = (n: number) => String(n).padStart(2, '0');
    return this.prisma.tx(async (tx) => {
      const party = await tx.party.findFirst({ where: { identification: w.issuer.ruc } });
      if (!party) warnings.push(`El cliente ${w.issuer.legalName} (${w.issuer.ruc}) no está registrado.`);
      const item = party ? await tx.accountItem.findFirst({ where: { side: 'AR', partyId: party.id, number: w.support.number } }) : null;
      if (party && !item) warnings.push(`No hay una cuenta por cobrar de la factura ${w.support.number} para este cliente (¿fue de contado?).`);
      if (item && item.status !== 'OPEN') warnings.push(`La factura ${w.support.number} ya está pagada.`);
      const dup = await tx.accountMovement.findFirst({ where: { side: 'AR', kind: 'WITHHOLDING', reference: `${w.establishment}-${w.emissionPoint}-${w.sequential}`, voidedAt: null } });
      if (dup) warnings.push('Esta retención ya fue registrada.');
      const total = w.items.reduce((a, i) => a.plus(i.amount), new D(0));
      return {
        partyId: party?.id ?? null,
        customerName: w.issuer.legalName,
        customerId: w.issuer.ruc,
        itemId: item?.id ?? null,
        invoiceNumber: w.support.number,
        number: `${w.establishment}-${w.emissionPoint}-${w.sequential}`,
        authorization: w.accessKey,
        date: `${w.issueDate.year}-${pad(w.issueDate.month)}-${pad(w.issueDate.day)}`,
        items: w.items.map((i) => ({ tax: i.tax, code: i.code, base: i.base, percentage: i.percentage, amount: i.amount })),
        total: m2(total),
        warnings,
      };
    });
  }

  /** Retención recibida de un cliente: reduce el saldo de la factura retenida. */
  async registerReceivedWithholding(input: ReceivedWithholdingParsed): Promise<{ id: string; unapplied: string }> {
    const { tenantId, userId } = this.ctx();
    return wrap(
      this.prisma.tx(async (tx) => {
        const item = await tx.accountItem.findFirst({ where: { id: input.itemId, side: 'AR' } });
        if (!item) throw new NotFoundException('Cuenta por cobrar no encontrada');
        const dup = await tx.accountMovement.findFirst({ where: { side: 'AR', partyId: item.partyId, kind: 'WITHHOLDING', reference: input.number, voidedAt: null } });
        if (dup) throw new UnprocessableEntityException(`La retención ${input.number} ya fue registrada`);
        for (const i of input.items) {
          const expected = m2(new D(i.base).times(i.percentage).div(100));
          if (expected !== m2(i.amount)) throw new UnprocessableEntityException(`Retención ${i.code}: ${i.base} × ${i.percentage}% = ${expected}, no ${m2(i.amount)}`);
        }
        const total = input.items.reduce((a, i) => a.plus(i.amount), new D(0));
        const res = await recordMovement(tx, {
          tenantId,
          side: 'AR',
          partyId: item.partyId,
          kind: 'WITHHOLDING',
          date: asDay(input.date),
          amount: m2(total),
          reference: input.number,
          data: { authorization: input.authorization, invoice: item.number, items: input.items },
          userId,
          allocations: [{ itemId: item.id, amount: m2(D.min(total, new D(item.balance.toString()))) }],
        });
        await this.audit.record(tx, { action: 'receivable.withholding', entity: 'account_movement', entityId: res.id, after: { invoice: item.number, number: input.number, total: m2(total) } });
        return res;
      }),
    );
  }

  async createOpening(side: Side, input: { partyId: string; number: string; issueDate: string; dueDate: string; amount: string; notes?: string | null }): Promise<{ id: string }> {
    const { tenantId, userId } = this.ctx();
    return wrap(
      this.prisma.tx(async (tx) => {
        const party = await tx.party.findFirst({ where: { id: input.partyId } });
        if (!party) throw new NotFoundException('Cliente o proveedor no encontrado');
        const id = await createItem(tx, {
          tenantId,
          side,
          partyId: party.id,
          sourceType: 'OPENING',
          sourceId: uuidv7(),
          number: input.number,
          issueDate: asDay(input.issueDate),
          dueDate: asDay(input.dueDate),
          amount: input.amount,
          notes: input.notes ?? 'Saldo inicial',
          userId,
        });
        await this.audit.record(tx, { action: side === 'AR' ? 'receivable.opening' : 'payable.opening', entity: 'account_item', entityId: id, after: input });
        return { id };
      }),
    );
  }

  async applyCredit(input: { movementId: string; itemId: string; amount: string }): Promise<void> {
    const { tenantId } = this.ctx();
    await wrap(
      this.prisma.tx(async (tx) => {
        await applyCredit(tx, tenantId, input.movementId, input.itemId, input.amount);
        await this.audit.record(tx, { action: 'account.apply_credit', entity: 'account_movement', entityId: input.movementId, after: input });
      }),
    );
  }

  async voidMovement(id: string, reason: string): Promise<void> {
    const { tenantId, userId } = this.ctx();
    await wrap(
      this.prisma.tx(async (tx) => {
        const mv = await tx.accountMovement.findFirst({ where: { id } });
        if (!mv) throw new NotFoundException('Movimiento no encontrado');
        if (mv.documentId) {
          throw new UnprocessableEntityException('Este movimiento viene de un comprobante electrónico (nota de crédito o retención emitida): no se anula aquí');
        }
        // El efectivo vuelve a la caja (o sale) con un movimiento de reverso, si la caja sigue abierta.
        if (mv.cashMovementId) {
          const cm = await tx.cashMovement.findFirst({ where: { id: mv.cashMovementId }, include: { session: true } });
          if (cm && cm.session.status === 'OPEN') {
            await tx.cashMovement.create({
              data: { id: uuidv7(), tenantId, sessionId: cm.sessionId, type: cm.type === 'IN' ? 'OUT' : 'IN', amount: cm.amount, reason: `Anulación: ${cm.reason}`, createdBy: userId },
            });
          }
        }
        const res = await voidMovement(tx, id, reason, userId);
        await this.audit.record(tx, { action: 'account.void', entity: 'account_movement', entityId: id, before: { amount: mv.amount.toString(), kind: mv.kind }, after: { reason, restored: res.allocations } });
      }),
    );
  }
}
