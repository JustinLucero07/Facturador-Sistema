import Decimal from 'decimal.js';

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
type Num = string | number | Decimal;

export const ENTRY_TYPES = ['INITIAL', 'PURCHASE', 'SALE_RETURN', 'ADJUSTMENT_IN', 'TRANSFER_IN'] as const;
export const EXIT_TYPES = ['SALE', 'ADJUSTMENT_OUT', 'TRANSFER_OUT', 'PURCHASE_RETURN'] as const;
export type MovementKind = (typeof ENTRY_TYPES)[number] | (typeof EXIT_TYPES)[number];

export function isEntry(type: MovementKind): boolean {
  return (ENTRY_TYPES as readonly string[]).includes(type);
}

/**
 * Costo promedio ponderado tras una ENTRADA (todas las bodegas del producto):
 *   nuevo = (existencia × promedio + cantidad × costo) / (existencia + cantidad)
 * Si la existencia previa es cero o negativa (venta sin stock), el promedio pasa a ser el costo de la entrada.
 * Las salidas no cambian el promedio: se valoran al promedio vigente.
 */
export function nextAverageCost(prevTotalQty: Num, prevAvg: Num, inQty: Num, inUnitCost: Num): string {
  const q0 = new D(prevTotalQty);
  const a0 = new D(prevAvg);
  const q = new D(inQty);
  const c = new D(inUnitCost);
  if (q.lte(0)) return a0.toFixed(6);
  if (q0.lte(0)) return c.toFixed(6);
  return q0.mul(a0).plus(q.mul(c)).div(q0.plus(q)).toDecimalPlaces(6).toFixed(6);
}

/** Convierte una cantidad en una presentación (caja de 12) a unidades base. */
export function toBaseUnits(quantity: Num, factor: Num): string {
  return new D(quantity).mul(new D(factor)).toDecimalPlaces(6).toFixed(6);
}

export { D as InvDecimal };
