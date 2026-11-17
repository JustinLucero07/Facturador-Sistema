import { Tx, uuidv7 } from '@vektra/db';
import Decimal from 'decimal.js';

/**
 * Libro de cuentas por cobrar (AR) y por pagar (AP).
 *  - AccountItem: lo que se debe (factura a crédito, compra, saldo inicial) con su saldo.
 *  - AccountMovement: lo que lo cancela (cobro/pago, retención, nota de crédito, anticipo).
 *  - AccountAllocation: cuánto de cada movimiento se aplicó a cada documento.
 * Lo no aplicado de un movimiento es saldo a favor (del cliente o con el proveedor).
 * Todas las funciones corren dentro de la transacción del llamador (withContext).
 */

export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Side = 'AR' | 'AP';
export type MovementKind = 'PAYMENT' | 'WITHHOLDING' | 'CREDIT_NOTE' | 'ADVANCE';
const m2 = (v: Decimal.Value) => new D(v).toDecimalPlaces(2).toFixed(2);

export class AccountsError extends Error {}

export interface NewItem {
  tenantId: string;
  side: Side;
  partyId: string;
  sourceType: 'INVOICE' | 'PURCHASE' | 'OPENING';
  sourceId?: string | null;
  number: string;
  issueDate: Date;
  dueDate: Date;
  amount: string;
  notes?: string | null;
  userId?: string | null;
}

/** Registra un documento por cobrar o por pagar (saldo = monto). */
export async function createItem(tx: Tx, it: NewItem): Promise<string> {
  if (!new D(it.amount).gt(0)) throw new AccountsError('El monto debe ser mayor a cero');
  if (it.dueDate < it.issueDate) throw new AccountsError('El vencimiento no puede ser anterior a la fecha de emisión');
  const id = uuidv7();
  await tx.accountItem.create({
    data: {
      id,
      tenantId: it.tenantId,
      side: it.side,
      partyId: it.partyId,
      sourceType: it.sourceType,
      sourceId: it.sourceId ?? null,
      number: it.number,
      issueDate: it.issueDate,
      dueDate: it.dueDate,
      amount: m2(it.amount),
      balance: m2(it.amount),
      notes: it.notes ?? null,
      createdBy: it.userId ?? null,
    },
  });
  return id;
}

export interface NewMovement {
  tenantId: string;
  side: Side;
  partyId: string;
  kind: MovementKind;
  date: Date;
  amount: string;
  method?: string | null;
  reference?: string | null;
  documentId?: string | null;
  cashMovementId?: string | null;
  data?: object | null;
  notes?: string | null;
  userId?: string | null;
  /**
   * Cómo se aplica:
   *  - lista explícita de documentos y montos;
   *  - 'auto': a los documentos abiertos del tercero, del más antiguo al más nuevo (primero `prefer`);
   *  - 'none': queda todo como saldo a favor (anticipo).
   */
  allocations: { itemId: string; amount: string }[] | 'auto' | 'none';
  prefer?: string | null;
}

/** Aplica `amount` a un documento abierto: baja el saldo y lo marca pagado si llega a cero. */
async function allocate(tx: Tx, tenantId: string, movementId: string, itemId: string, amount: InstanceType<typeof D>): Promise<void> {
  // Bloquea la fila: dos cobros simultáneos no pueden dejar el saldo en negativo.
  const [row] = await tx.$queryRaw<{ balance: string; status: string }[]>`SELECT balance::text, status FROM account_item WHERE id = ${itemId}::uuid FOR UPDATE`;
  if (!row || row.status === 'VOID') throw new AccountsError('Documento no encontrado o anulado');
  const balance = new D(row.balance);
  if (amount.gt(balance)) throw new AccountsError(`El valor aplicado (${m2(amount)}) supera el saldo del documento (${m2(balance)})`);
  const next = balance.minus(amount);
  await tx.accountItem.update({ where: { id: itemId }, data: { balance: m2(next), status: next.lte(0) ? 'PAID' : 'OPEN' } });
  await tx.accountAllocation.create({ data: { id: uuidv7(), tenantId, movementId, itemId, amount: m2(amount) } });
}

/** Registra un cobro/pago/retención/nota de crédito y lo aplica. Devuelve el id y lo que quedó sin aplicar. */
export async function recordMovement(tx: Tx, mv: NewMovement): Promise<{ id: string; unapplied: string }> {
  const total = new D(mv.amount);
  if (!total.gt(0)) throw new AccountsError('El valor debe ser mayor a cero');
  const id = uuidv7();
  await tx.accountMovement.create({
    data: {
      id,
      tenantId: mv.tenantId,
      side: mv.side,
      partyId: mv.partyId,
      kind: mv.kind,
      date: mv.date,
      method: mv.method ?? null,
      amount: m2(total),
      unapplied: m2(total),
      reference: mv.reference ?? null,
      documentId: mv.documentId ?? null,
      cashMovementId: mv.cashMovementId ?? null,
      data: (mv.data ?? undefined) as object | undefined,
      notes: mv.notes ?? null,
      createdBy: mv.userId ?? null,
    },
  });

  let left = total;
  if (Array.isArray(mv.allocations)) {
    for (const a of mv.allocations) {
      const amt = new D(a.amount);
      if (amt.lte(0)) continue;
      const item = await tx.accountItem.findFirst({ where: { id: a.itemId } });
      if (!item || item.side !== mv.side || item.partyId !== mv.partyId) throw new AccountsError('El documento no pertenece a este cliente/proveedor');
      if (amt.gt(left)) throw new AccountsError('Lo aplicado a los documentos supera el valor registrado');
      await allocate(tx, mv.tenantId, id, a.itemId, amt);
      left = left.minus(amt);
    }
  } else if (mv.allocations === 'auto') {
    const open = await tx.accountItem.findMany({
      where: { side: mv.side, partyId: mv.partyId, status: 'OPEN' },
      orderBy: [{ dueDate: 'asc' }, { issueDate: 'asc' }, { createdAt: 'asc' }],
    });
    const ordered = mv.prefer ? [...open.filter((o) => o.id === mv.prefer), ...open.filter((o) => o.id !== mv.prefer)] : open;
    for (const it of ordered) {
      if (left.lte(0)) break;
      const amt = D.min(left, new D(it.balance.toString()));
      if (amt.lte(0)) continue;
      await allocate(tx, mv.tenantId, id, it.id, amt);
      left = left.minus(amt);
    }
  }
  if (!left.eq(total)) await tx.accountMovement.update({ where: { id }, data: { unapplied: m2(left) } });
  return { id, unapplied: m2(left) };
}

/** Usa el saldo a favor de un movimiento para cancelar un documento. */
export async function applyCredit(tx: Tx, tenantId: string, movementId: string, itemId: string, amount: string): Promise<void> {
  const [mv] = await tx.$queryRaw<{ unapplied: string; side: string; party_id: string; voided_at: Date | null }[]>`
    SELECT unapplied::text, side, party_id, voided_at FROM account_movement WHERE id = ${movementId}::uuid FOR UPDATE`;
  if (!mv || mv.voided_at) throw new AccountsError('Saldo a favor no encontrado');
  const amt = new D(amount);
  if (amt.lte(0) || amt.gt(mv.unapplied)) throw new AccountsError(`Solo hay ${m2(mv.unapplied)} de saldo a favor`);
  const item = await tx.accountItem.findFirst({ where: { id: itemId } });
  if (!item || item.side !== mv.side || item.partyId !== mv.party_id) throw new AccountsError('El documento no pertenece a este cliente/proveedor');
  await allocate(tx, tenantId, movementId, itemId, amt);
  await tx.accountMovement.update({ where: { id: movementId }, data: { unapplied: m2(new D(mv.unapplied).minus(amt)) } });
}

/** Anula un movimiento: devuelve el saldo a los documentos que había cancelado. */
export async function voidMovement(tx: Tx, movementId: string, reason: string, userId: string | null): Promise<{ allocations: { itemId: string; amount: string }[] }> {
  const mv = await tx.accountMovement.findFirst({ where: { id: movementId }, include: { allocations: true } });
  if (!mv) throw new AccountsError('Movimiento no encontrado');
  if (mv.voidedAt) throw new AccountsError('El movimiento ya está anulado');
  for (const a of mv.allocations) {
    const [row] = await tx.$queryRaw<{ balance: string; status: string }[]>`SELECT balance::text, status FROM account_item WHERE id = ${a.itemId}::uuid FOR UPDATE`;
    if (row && row.status !== 'VOID') {
      await tx.accountItem.update({ where: { id: a.itemId }, data: { balance: m2(new D(row.balance).plus(a.amount.toString())), status: 'OPEN' } });
    }
  }
  const snapshot = mv.allocations.map((a) => ({ itemId: a.itemId, amount: a.amount.toString() }));
  await tx.accountAllocation.deleteMany({ where: { movementId } });
  await tx.accountMovement.update({
    where: { id: movementId },
    data: {
      voidedAt: new Date(),
      voidedBy: userId,
      voidReason: reason,
      unapplied: '0',
      data: { ...((mv.data as object | null) ?? {}), voidedAllocations: snapshot },
    },
  });
  return { allocations: snapshot };
}

/** Saldo de un tercero: lo que debe (o se le debe), lo vencido y el saldo a favor. */
export async function partyBalance(tx: Tx, side: Side, partyId: string, today = new Date()): Promise<{ owed: string; overdue: string; credit: string }> {
  const items = await tx.accountItem.findMany({ where: { side, partyId, status: 'OPEN' }, select: { balance: true, dueDate: true } });
  const credits = await tx.accountMovement.aggregate({ where: { side, partyId, voidedAt: null }, _sum: { unapplied: true } });
  const owed = items.reduce((a, i) => a.plus(i.balance.toString()), new D(0));
  const overdue = items.filter((i) => i.dueDate < startOfDay(today)).reduce((a, i) => a.plus(i.balance.toString()), new D(0));
  return { owed: m2(owed), overdue: m2(overdue), credit: m2(credits._sum.unapplied?.toString() ?? 0) };
}

export function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

/** Días de vencido (0 si aún no vence). */
export function daysOverdue(due: Date, today = new Date()): number {
  return Math.max(0, Math.floor((startOfDay(today).getTime() - startOfDay(due).getTime()) / 86_400_000));
}

/** Tramo de antigüedad de saldos. */
export function agingBucket(due: Date, today = new Date()): 'current' | 'd30' | 'd60' | 'd90' | 'over90' {
  const d = daysOverdue(due, today);
  if (d === 0) return 'current';
  if (d <= 30) return 'd30';
  if (d <= 60) return 'd60';
  if (d <= 90) return 'd90';
  return 'over90';
}
