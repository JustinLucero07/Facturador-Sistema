import { Tx, uuidv7 } from '@vektra/db';
import { InvDecimal as D, isEntry, MovementKind, nextAverageCost } from './cost';

export class InventoryError extends Error {}

export interface MovementInput {
  tenantId: string;
  productId: string;
  warehouseId: string;
  type: MovementKind;
  /** Cantidad en unidades base, SIEMPRE positiva; el signo lo da el tipo. */
  quantity: string;
  /** Costo unitario de la entrada (compra, saldo inicial, ajuste). Si se omite: costo promedio vigente. */
  unitCost?: string | null;
  allowNegative: boolean;
  documentId?: string | null;
  batchId?: string | null;
  reason?: string | null;
  userId?: string | null;
}

export interface MovementResult {
  id: string;
  balanceAfter: string;
  avgCostAfter: string;
  unitCost: string;
}

/**
 * Registra un movimiento de kárdex de forma atómica dentro de la transacción del llamador:
 *  - bloquea la fila del producto (SELECT … FOR UPDATE) para que dos cajas no calculen el promedio a la vez,
 *  - actualiza el stock de la bodega y el costo promedio del producto,
 *  - valida stock suficiente si la empresa no permite stock negativo.
 * Los servicios no llevan stock: devuelve null.
 */
export async function applyMovement(tx: Tx, input: MovementInput): Promise<MovementResult | null> {
  const qty = new D(input.quantity);
  if (qty.lte(0)) throw new InventoryError('La cantidad debe ser mayor a cero');

  const [product] = await tx.$queryRaw<{ id: string; name: string; avg_cost: string; is_service: boolean }[]>`
    SELECT id, name, avg_cost::text, is_service FROM product WHERE id = ${input.productId}::uuid FOR UPDATE`;
  if (!product) throw new InventoryError('Producto no encontrado');
  if (product.is_service) return null;

  const warehouse = await tx.warehouse.findFirst({ where: { id: input.warehouseId }, select: { id: true, name: true, active: true } });
  if (!warehouse) throw new InventoryError('Bodega no encontrada');

  const [stockRow] = await tx.$queryRaw<{ quantity: string }[]>`
    SELECT quantity::text FROM stock WHERE warehouse_id = ${input.warehouseId}::uuid AND product_id = ${input.productId}::uuid FOR UPDATE`;
  const [totals] = await tx.$queryRaw<{ total: string | null }[]>`
    SELECT COALESCE(SUM(quantity), 0)::text AS total FROM stock WHERE product_id = ${input.productId}::uuid`;

  const whQty = new D(stockRow?.quantity ?? 0);
  const totalQty = new D(totals?.total ?? 0);
  const avg = new D(product.avg_cost);
  const entry = isEntry(input.type);

  let unitCost: InstanceType<typeof D>;
  let newAvg: string;
  if (entry) {
    unitCost = input.unitCost !== undefined && input.unitCost !== null ? new D(input.unitCost) : avg;
    if (unitCost.lt(0)) throw new InventoryError('El costo no puede ser negativo');
    newAvg = nextAverageCost(totalQty, avg, qty, unitCost);
  } else {
    unitCost = avg;
    newAvg = avg.toFixed(6);
    if (!input.allowNegative && whQty.minus(qty).lt(0)) {
      throw new InventoryError(
        `Stock insuficiente de "${product.name}" en ${warehouse.name}: disponible ${trim(whQty)}, se requieren ${trim(qty)}`,
      );
    }
  }

  const signed = entry ? qty : qty.neg();
  const balanceAfter = whQty.plus(signed);

  await tx.$executeRaw`
    INSERT INTO stock (tenant_id, warehouse_id, product_id, quantity, updated_at)
    VALUES (app_current_tenant(), ${input.warehouseId}::uuid, ${input.productId}::uuid, ${balanceAfter.toFixed(6)}::numeric, now())
    ON CONFLICT (warehouse_id, product_id) DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now()`;

  const costBearing = ['INITIAL', 'PURCHASE', 'ADJUSTMENT_IN'].includes(input.type) && input.unitCost != null;
  await tx.product.update({
    where: { id: input.productId },
    data: { avgCost: newAvg, ...(costBearing ? { lastCost: unitCost.toFixed(6) } : {}) },
  });

  const id = uuidv7();
  await tx.inventoryMovement.create({
    data: {
      id,
      tenantId: input.tenantId,
      productId: input.productId,
      warehouseId: input.warehouseId,
      type: input.type,
      quantity: signed.toFixed(6),
      unitCost: unitCost.toFixed(6),
      totalCost: signed.mul(unitCost).toFixed(6),
      avgCostAfter: newAvg,
      balanceAfter: balanceAfter.toFixed(6),
      documentId: input.documentId ?? null,
      batchId: input.batchId ?? null,
      reason: input.reason ?? null,
      createdBy: input.userId ?? null,
    },
  });
  return { id, balanceAfter: balanceAfter.toFixed(6), avgCostAfter: newAvg, unitCost: unitCost.toFixed(6) };
}

function trim(d: InstanceType<typeof D>): string {
  return d.toDecimalPlaces(6).toString();
}

/** Bodega principal del establecimiento (para descontar ventas). */
export async function defaultWarehouseId(tx: Tx, establishmentId: string): Promise<string> {
  const w =
    (await tx.warehouse.findFirst({ where: { establishmentId, isDefault: true, active: true }, select: { id: true } })) ??
    (await tx.warehouse.findFirst({ where: { establishmentId, active: true }, orderBy: { createdAt: 'asc' }, select: { id: true } }));
  if (!w) throw new InventoryError('El establecimiento no tiene una bodega activa');
  return w.id;
}

export async function allowsNegativeStock(tx: Tx, tenantId: string): Promise<boolean> {
  const t = await tx.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
  const s = (t?.settings ?? {}) as { allowNegativeStock?: boolean };
  return s.allowNegativeStock ?? true;
}

export interface TransferItem {
  productId: string;
  quantity: string;
}

/** Transferencia entre bodegas: salida en origen y entrada en destino al costo promedio. */
export async function transferStock(
  tx: Tx,
  args: { tenantId: string; fromWarehouseId: string; toWarehouseId: string; items: TransferItem[]; reason?: string | null; userId?: string | null },
): Promise<string> {
  if (args.fromWarehouseId === args.toWarehouseId) throw new InventoryError('La bodega de origen y destino deben ser distintas');
  const batchId = uuidv7();
  for (const item of args.items) {
    // Una transferencia nunca deja la bodega origen en negativo
    await applyMovement(tx, { ...base(args, batchId), productId: item.productId, warehouseId: args.fromWarehouseId, type: 'TRANSFER_OUT', quantity: item.quantity, allowNegative: false });
    await applyMovement(tx, { ...base(args, batchId), productId: item.productId, warehouseId: args.toWarehouseId, type: 'TRANSFER_IN', quantity: item.quantity, allowNegative: true });
  }
  return batchId;
}

const base = (a: { tenantId: string; reason?: string | null; userId?: string | null }, batchId: string) => ({
  tenantId: a.tenantId,
  reason: a.reason ?? null,
  userId: a.userId ?? null,
  batchId,
});
