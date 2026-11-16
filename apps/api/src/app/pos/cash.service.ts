import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, Tx, uuidv7 } from '@vektra/db';
import { loadSriSettings } from '@vektra/einvoice';
import type { CashSessionSummary, PaymentMethodDef } from '@vektra/shared-contracts';
import Decimal from 'decimal.js';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../common/prisma.service';
import { currentContext } from '../common/request-context';

const D = Decimal.clone({ rounding: Decimal.ROUND_HALF_UP });
const m2 = (v: Decimal.Value) => new D(v).toFixed(2);

@Injectable()
export class CashService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private ctx() {
    const c = currentContext();
    return { tenantId: c.tenantId as string, userId: c.userId as string, supervise: c.permissions?.has('cash.supervise') ?? false };
  }

  async current(emissionPointId: string): Promise<CashSessionSummary | null> {
    const s = await this.prisma.tx((tx) => tx.cashSession.findFirst({ where: { emissionPointId, status: 'OPEN' } }));
    return s ? this.summary(s.id) : null;
  }

  async open(emissionPointId: string, openingAmount: string): Promise<CashSessionSummary> {
    const { tenantId, userId } = this.ctx();
    const id = uuidv7();
    await this.prisma.tx(async (tx) => {
      const ep = await tx.emissionPoint.findFirst({ where: { id: emissionPointId, active: true } });
      if (!ep) throw new NotFoundException('Punto de emisión no encontrado');
      if (ep.kind !== 'WEB') throw new UnprocessableEntityException('Este punto de emisión pertenece a una caja de escritorio');
      const open = await tx.cashSession.findFirst({ where: { emissionPointId, status: 'OPEN' } });
      if (open) throw new ConflictException('Ya hay una caja abierta en este punto de emisión');
      await tx.cashSession.create({ data: { id, tenantId, emissionPointId, openedBy: userId, openingAmount } });
      await this.audit.record(tx, { action: 'cash.open', entity: 'cash_session', entityId: id, after: { emissionPointId, openingAmount } });
    }).catch((e) => {
      if ((e as { code?: string }).code === 'P2002') throw new ConflictException('Ya hay una caja abierta en este punto de emisión');
      throw e;
    });
    return this.summary(id);
  }

  async movement(sessionId: string, input: { type: 'IN' | 'OUT'; amount: string; reason: string }): Promise<CashSessionSummary> {
    const { tenantId, userId } = this.ctx();
    await this.prisma.tx(async (tx) => {
      const s = await this.openSession(tx, sessionId);
      await tx.cashMovement.create({ data: { id: uuidv7(), tenantId, sessionId: s.id, type: input.type, amount: input.amount, reason: input.reason, createdBy: userId } });
      await this.audit.record(tx, { action: `cash.${input.type === 'IN' ? 'income' : 'expense'}`, entity: 'cash_session', entityId: sessionId, after: input });
    });
    return this.summary(sessionId);
  }

  private async openSession(tx: Tx, id: string) {
    const s = await tx.cashSession.findFirst({ where: { id } });
    if (!s) throw new NotFoundException('Caja no encontrada');
    if (s.status !== 'OPEN') throw new UnprocessableEntityException('La caja ya está cerrada');
    return s;
  }

  /** Cálculo del arqueo: lo esperado por cada medio de pago y en efectivo. */
  async summary(sessionId: string): Promise<CashSessionSummary> {
    const { userId, supervise } = this.ctx();
    const methods = (await loadSriSettings(this.prisma.client)).paymentMethods;
    const data = await this.prisma.tx(async (tx) => {
      const s = await tx.cashSession.findFirst({ where: { id: sessionId }, include: { movements: { orderBy: { at: 'asc' } } } });
      if (!s) return null;
      const ep = await tx.emissionPoint.findFirst({ where: { id: s.emissionPointId }, include: { establishment: true } });
      const payments = await tx.documentPayment.groupBy({
        by: ['method'],
        where: { document: { cashSessionId: sessionId, status: 'ISSUED' } },
        _sum: { amount: true },
        _count: true,
      });
      const docs = await tx.document.groupBy({ by: ['createdBy'], where: { cashSessionId: sessionId, status: 'ISSUED' }, _sum: { total: true }, _count: true });
      return { s, ep, payments, docs };
    });
    if (!data) throw new NotFoundException('Caja no encontrada');
    const { s, ep, payments, docs } = data;
    if (!supervise && s.openedBy !== userId && !docs.some((d) => d.createdBy === userId)) {
      throw new ForbiddenException('Solo puede ver sus propias cajas');
    }

    const userIds = [...new Set([s.openedBy, s.closedBy, ...s.movements.map((m) => m.createdBy), ...docs.map((d) => d.createdBy)].filter((x): x is string => !!x))];
    const users = await this.prisma.client.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true } });
    const name = (id: string | null) => (id ? (users.find((u) => u.id === id)?.fullName ?? '—') : null);

    const cashMethods = new Set(methods.filter((m) => m.cash).map((m) => m.method));
    const sum = (f: (x: (typeof s.movements)[number]) => boolean) => s.movements.filter(f).reduce((a, m) => a.plus(m.amount.toString()), new D(0));
    const cashIn = sum((m) => m.type === 'IN');
    const cashOut = sum((m) => m.type === 'OUT');
    const cashSales = payments.filter((p) => cashMethods.has(p.method)).reduce((a, p) => a.plus(p._sum.amount?.toString() ?? 0), new D(0));
    const cashExpected = new D(s.openingAmount.toString()).plus(cashSales).plus(cashIn).minus(cashOut);
    const counted = (s.counted ?? null) as Record<string, string> | null;

    const known = new Map<string, PaymentMethodDef>(methods.map((m) => [m.method, m]));
    const methodKeys = [...new Set([...methods.map((m) => m.method), ...payments.map((p) => p.method)])];
    const methodRows = methodKeys
      .map((method) => {
        const p = payments.find((x) => x.method === method);
        const isCash = cashMethods.has(method);
        const expected = isCash ? cashExpected : new D(p?._sum.amount?.toString() ?? 0);
        const c = counted?.[method];
        return {
          method,
          label: known.get(method)?.label ?? method,
          sales: m2(p?._sum.amount?.toString() ?? 0),
          count: p?._count ?? 0,
          expected: m2(expected),
          counted: c !== undefined ? m2(c) : null,
          difference: c !== undefined ? m2(new D(c).minus(expected)) : null,
        };
      })
      .filter((r) => r.count > 0 || cashMethods.has(r.method) || r.counted !== null);

    return {
      id: s.id,
      status: s.status,
      emissionPointId: s.emissionPointId,
      emissionPoint: ep ? `${ep.establishment.code}-${ep.code} · ${ep.name}` : '',
      openedBy: name(s.openedBy) ?? '',
      openedAt: s.openedAt.toISOString(),
      openingAmount: m2(s.openingAmount.toString()),
      closedBy: name(s.closedBy),
      closedAt: s.closedAt?.toISOString() ?? null,
      invoices: docs.reduce((a, d) => a + d._count, 0),
      totalSales: m2(docs.reduce((a, d) => a.plus(d._sum.total?.toString() ?? 0), new D(0))),
      cash: { opening: m2(s.openingAmount.toString()), sales: m2(cashSales), in: m2(cashIn), out: m2(cashOut), expected: m2(cashExpected) },
      methods: methodRows,
      byUser: docs.map((d) => ({ user: name(d.createdBy) ?? '—', invoices: d._count, total: m2(d._sum.total?.toString() ?? 0) })),
      movements: s.movements.map((mv) => ({ id: mv.id, type: mv.type as 'IN' | 'OUT', amount: m2(mv.amount.toString()), reason: mv.reason, user: name(mv.createdBy) ?? '', at: mv.at.toISOString() })),
      difference: s.difference ? m2(s.difference.toString()) : null,
      notes: s.notes,
    };
  }

  /** Arqueo y cierre: guarda lo esperado y lo contado; la diferencia queda registrada. */
  async close(sessionId: string, input: { counted: Record<string, string>; denominations?: Record<string, number>; notes?: string | null }): Promise<CashSessionSummary> {
    const { userId } = this.ctx();
    const before = await this.summary(sessionId);
    if (before.status !== 'OPEN') throw new UnprocessableEntityException('La caja ya está cerrada');
    const expected = Object.fromEntries(before.methods.map((m) => [m.method, m.expected]));
    const counted = Object.fromEntries(before.methods.map((m) => [m.method, input.counted[m.method] ?? '0']));
    const difference = before.methods.reduce((a, m) => a.plus(counted[m.method]).minus(m.expected), new D(0));
    await this.prisma.tx(async (tx) => {
      await this.openSession(tx, sessionId);
      await tx.cashSession.update({
        where: { id: sessionId },
        data: {
          status: 'CLOSED',
          closedBy: userId,
          closedAt: new Date(),
          expected,
          counted,
          denominations: (input.denominations ?? Prisma.DbNull) as Prisma.InputJsonValue,
          difference: m2(difference),
          notes: input.notes ?? null,
        },
      });
      await this.audit.record(tx, { action: 'cash.close', entity: 'cash_session', entityId: sessionId, after: { expected, counted, difference: m2(difference) } });
    });
    return this.summary(sessionId);
  }

  async list(page: number, pageSize: number) {
    const { userId, supervise } = this.ctx();
    const where: Prisma.CashSessionWhereInput = supervise ? {} : { openedBy: userId };
    const [total, rows] = await this.prisma.tx((tx) =>
      Promise.all([tx.cashSession.count({ where }), tx.cashSession.findMany({ where, orderBy: { openedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, select: { id: true } })]),
    );
    const items = [];
    for (const r of rows) items.push(await this.summary(r.id));
    return { total, page, pageSize, items };
  }
}
