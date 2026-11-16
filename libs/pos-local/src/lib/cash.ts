import { uuidv7 } from '@vektra/db/uuid';
import type { CashSessionSummary, PaymentMethodDef } from '@vektra/shared-contracts';
import { cashMovementSchema, closeCashSchema, openCashSchema } from '@vektra/shared-contracts';
import { LocalUser, requirePerm } from './auth';
import { EngineContext } from './context';
import { D, HttpError, json, m2, notFound, unprocessable } from './util';

interface SessionRow {
  id: string;
  status: 'OPEN' | 'CLOSED';
  opened_by: string;
  opened_at: string;
  opening_amount: string;
  closed_by: string | null;
  closed_at: string | null;
  counted: string | null;
  difference: string | null;
  notes: string | null;
}

/**
 * Turnos de caja en la computadora. Misma regla de arqueo que el servidor:
 * efectivo esperado = apertura + ventas cobradas en efectivo + ingresos − egresos.
 */
export class LocalCash {
  constructor(private readonly ctx: EngineContext) {}

  private userName(id: string | null): string | null {
    if (!id) return null;
    return this.ctx.db.get<{ full_name: string }>('SELECT full_name FROM users WHERE id = ?', id)?.full_name ?? '—';
  }

  current(emissionPointId: string, user: LocalUser): CashSessionSummary | null {
    const cfg = this.ctx.requireConfig();
    if (emissionPointId !== cfg.emissionPoint.id) return null;
    const s = this.ctx.db.get<SessionRow>("SELECT * FROM cash_sessions WHERE status = 'OPEN'");
    return s ? this.summary(s.id, user) : null;
  }

  open(user: LocalUser, body: unknown): CashSessionSummary {
    requirePerm(user, 'cash.operate');
    const parsed = openCashSchema.safeParse(body);
    if (!parsed.success) throw unprocessable(parsed.error.issues[0]?.message ?? 'Datos inválidos');
    const cfg = this.ctx.requireConfig();
    if (parsed.data.emissionPointId !== cfg.emissionPoint.id) throw unprocessable('Esta caja solo opera en su propio punto de emisión');
    const id = uuidv7();
    const openedAt = this.ctx.now().toISOString();
    this.ctx.db.tx(() => {
      if (this.ctx.db.get("SELECT 1 FROM cash_sessions WHERE status = 'OPEN'")) throw new HttpError(409, 'Ya hay una caja abierta');
      this.ctx.db.run(
        "INSERT INTO cash_sessions (id, status, opened_by, opened_at, opening_amount) VALUES (?, 'OPEN', ?, ?, ?)",
        id,
        user.id,
        openedAt,
        m2(parsed.data.openingAmount),
      );
      this.ctx.enqueue('cash.open', { id, openedAt, openingAmount: m2(parsed.data.openingAmount) }, user.id);
    });
    return this.summary(id, user);
  }

  movement(user: LocalUser, sessionId: string, body: unknown): CashSessionSummary {
    requirePerm(user, 'cash.operate');
    const parsed = cashMovementSchema.safeParse(body);
    if (!parsed.success) throw unprocessable(parsed.error.issues[0]?.message ?? 'Datos inválidos');
    const id = uuidv7();
    const at = this.ctx.now().toISOString();
    this.ctx.db.tx(() => {
      this.openSession(sessionId);
      const amount = m2(parsed.data.amount);
      this.ctx.db.run('INSERT INTO cash_movements (id, session_id, type, amount, reason, created_by, at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, sessionId, parsed.data.type, amount, parsed.data.reason, user.id, at);
      this.ctx.enqueue('cash.movement', { id, sessionId, type: parsed.data.type, amount, reason: parsed.data.reason, at }, user.id);
    });
    return this.summary(sessionId, user);
  }

  private openSession(id: string): SessionRow {
    const s = this.ctx.db.get<SessionRow>('SELECT * FROM cash_sessions WHERE id = ?', id);
    if (!s) throw notFound('Caja no encontrada');
    if (s.status !== 'OPEN') throw unprocessable('La caja ya está cerrada');
    return s;
  }

  summary(sessionId: string, user: LocalUser): CashSessionSummary {
    const cfg = this.ctx.requireConfig();
    const s = this.ctx.db.get<SessionRow>('SELECT * FROM cash_sessions WHERE id = ?', sessionId);
    if (!s) throw notFound('Caja no encontrada');
    if (!user.permissions.has('cash.supervise') && s.opened_by !== user.id && !user.permissions.has('cash.operate')) {
      throw new HttpError(403, 'Solo puede ver sus propias cajas');
    }
    const methods: PaymentMethodDef[] = cfg.paymentMethods;
    const movements = this.ctx.db.all<{ id: string; type: 'IN' | 'OUT'; amount: string; reason: string; created_by: string; at: string }>(
      'SELECT * FROM cash_movements WHERE session_id = ? ORDER BY at',
      sessionId,
    );
    const docs = this.ctx.db.all<{ created_by: string; total: string; payments: string }>('SELECT created_by, total, payments FROM documents WHERE cash_session_id = ?', sessionId);

    const byMethod = new Map<string, { sum: InstanceType<typeof D>; count: number }>();
    for (const d of docs) {
      for (const p of json<{ method: string; amount: string }[]>(d.payments, [])) {
        const cur = byMethod.get(p.method) ?? { sum: new D(0), count: 0 };
        byMethod.set(p.method, { sum: cur.sum.plus(p.amount), count: cur.count + 1 });
      }
    }
    const cashMethods = new Set(methods.filter((m) => m.cash).map((m) => m.method));
    const sumMov = (t: 'IN' | 'OUT') => movements.filter((m) => m.type === t).reduce((a, m) => a.plus(m.amount), new D(0));
    const cashIn = sumMov('IN');
    const cashOut = sumMov('OUT');
    const cashSales = [...byMethod].filter(([m]) => cashMethods.has(m)).reduce((a, [, v]) => a.plus(v.sum), new D(0));
    const cashExpected = new D(s.opening_amount).plus(cashSales).plus(cashIn).minus(cashOut);
    const counted = json<Record<string, string> | null>(s.counted, null);
    const known = new Map(methods.map((m) => [m.method, m]));
    const keys = [...new Set([...methods.map((m) => m.method), ...byMethod.keys()])];
    const methodRows = keys
      .map((method) => {
        const p = byMethod.get(method);
        const isCash = cashMethods.has(method);
        const expected = isCash ? cashExpected : (p?.sum ?? new D(0));
        const c = counted?.[method];
        return {
          method,
          label: known.get(method)?.label ?? method,
          sales: m2(p?.sum ?? 0),
          count: p?.count ?? 0,
          expected: m2(expected),
          counted: c !== undefined ? m2(c) : null,
          difference: c !== undefined ? m2(new D(c).minus(expected)) : null,
        };
      })
      .filter((r) => r.count > 0 || cashMethods.has(r.method) || r.counted !== null);

    const byUser = new Map<string, { invoices: number; total: InstanceType<typeof D> }>();
    for (const d of docs) {
      const cur = byUser.get(d.created_by) ?? { invoices: 0, total: new D(0) };
      byUser.set(d.created_by, { invoices: cur.invoices + 1, total: cur.total.plus(d.total) });
    }
    const ep = cfg.emissionPoint;
    return {
      id: s.id,
      status: s.status,
      emissionPointId: ep.id,
      emissionPoint: `${ep.establishmentCode}-${ep.code} · ${ep.name}`,
      openedBy: this.userName(s.opened_by) ?? '',
      openedAt: s.opened_at,
      openingAmount: m2(s.opening_amount),
      closedBy: this.userName(s.closed_by),
      closedAt: s.closed_at,
      invoices: docs.length,
      totalSales: m2(docs.reduce((a, d) => a.plus(d.total), new D(0))),
      cash: { opening: m2(s.opening_amount), sales: m2(cashSales), in: m2(cashIn), out: m2(cashOut), expected: m2(cashExpected) },
      methods: methodRows,
      byUser: [...byUser].map(([uid, v]) => ({ user: this.userName(uid) ?? '—', invoices: v.invoices, total: m2(v.total) })),
      movements: movements.map((mv) => ({ id: mv.id, type: mv.type, amount: m2(mv.amount), reason: mv.reason, user: this.userName(mv.created_by) ?? '', at: mv.at })),
      difference: s.difference,
      notes: s.notes,
    };
  }

  close(user: LocalUser, sessionId: string, body: unknown): CashSessionSummary {
    requirePerm(user, 'cash.operate');
    const parsed = closeCashSchema.safeParse(body);
    if (!parsed.success) throw unprocessable(parsed.error.issues[0]?.message ?? 'Datos inválidos');
    const before = this.summary(sessionId, user);
    if (before.status !== 'OPEN') throw unprocessable('La caja ya está cerrada');
    const expected = Object.fromEntries(before.methods.map((m) => [m.method, m.expected]));
    const counted = Object.fromEntries(before.methods.map((m) => [m.method, m2(parsed.data.counted[m.method] ?? '0')]));
    const difference = m2(before.methods.reduce((a, m) => a.plus(counted[m.method]).minus(m.expected), new D(0)));
    const closedAt = this.ctx.now().toISOString();
    this.ctx.db.tx(() => {
      this.openSession(sessionId);
      this.ctx.db.run(
        "UPDATE cash_sessions SET status = 'CLOSED', closed_by = ?, closed_at = ?, expected = ?, counted = ?, denominations = ?, difference = ?, notes = ? WHERE id = ?",
        user.id,
        closedAt,
        JSON.stringify(expected),
        JSON.stringify(counted),
        parsed.data.denominations ? JSON.stringify(parsed.data.denominations) : null,
        difference,
        parsed.data.notes ?? null,
        sessionId,
      );
      this.ctx.enqueue(
        'cash.close',
        { sessionId, closedAt, expected, counted, denominations: parsed.data.denominations, difference, notes: parsed.data.notes ?? null },
        user.id,
      );
    });
    return this.summary(sessionId, user);
  }
}
