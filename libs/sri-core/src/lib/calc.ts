import { D, dec, Dec, money, Num, rate2, six } from './money';

/**
 * Cálculo de líneas y totales de un comprobante de venta.
 * Reglas tomadas de la Ficha Técnica offline v2.34:
 *  - Tabla 21: el valor de IVA se calcula sobre la base agrupada por tarifa ("Subtotal IVA _%" × tarifa),
 *    el total suma subtotal + ICE + IRBPNR + IVA + propina; la propina no supera el 10 % del subtotal.
 *  - 9.17: valores con 2 decimales; cantidad y precio unitario hasta 6 decimales.
 * Las tarifas NO se fijan aquí: llegan desde la base de datos (tabla tax_rate).
 */

export interface TaxRateRef {
  /** Tabla 16: 2 IVA, 3 ICE, 5 IRBPNR */
  taxCode: string;
  /** Tabla 17 (IVA): 0, 2, 3, 4, 5, 6, 7, 8, 10 */
  percentageCode: string;
  /** Porcentaje, ej. 15 para 15 %. 0 para 0 %, no objeto y exento. */
  rate: Num;
}

export interface LineInput {
  mainCode?: string | null;
  auxCode?: string | null;
  description: string;
  unit?: string | null;
  quantity: Num;
  unitPrice: Num;
  discount?: Num;
  taxes: TaxRateRef[];
  additional?: { name: string; value: string }[];
}

export interface LineTax {
  taxCode: string;
  percentageCode: string;
  rate: string;
  base: string;
  amount: string;
}

export interface ComputedLine {
  mainCode: string | null;
  auxCode: string | null;
  description: string;
  unit: string | null;
  quantity: string;
  unitPrice: string;
  discount: string;
  /** precioTotalSinImpuesto */
  subtotal: string;
  taxes: LineTax[];
  additional: { name: string; value: string }[];
}

export interface TaxGroup {
  taxCode: string;
  percentageCode: string;
  rate: string;
  base: string;
  amount: string;
}

export interface Totals {
  /** totalSinImpuestos */
  subtotal: string;
  totalDiscount: string;
  taxGroups: TaxGroup[];
  /** Suma de todos los impuestos */
  totalTax: string;
  tip: string;
  /** importeTotal */
  total: string;
}

export interface ComputedInvoice {
  lines: ComputedLine[];
  totals: Totals;
}

export class CalculationError extends Error {}

export function computeLines(lines: LineInput[]): ComputedLine[] {
  if (lines.length === 0) throw new CalculationError('El comprobante debe tener al menos un detalle');
  return lines.map((l, i) => {
    const n = i + 1;
    const qty = dec(l.quantity);
    const price = dec(l.unitPrice);
    const discount = dec(l.discount ?? 0);
    if (qty.lte(0)) throw new CalculationError(`Línea ${n}: la cantidad debe ser mayor a cero`);
    if (price.lt(0)) throw new CalculationError(`Línea ${n}: el precio no puede ser negativo`);
    if (discount.lt(0)) throw new CalculationError(`Línea ${n}: el descuento no puede ser negativo`);
    if (!l.description?.trim()) throw new CalculationError(`Línea ${n}: falta la descripción`);
    if (l.taxes.length === 0) throw new CalculationError(`Línea ${n}: debe indicar el impuesto (tarifa de IVA)`);

    // Se usan los valores ya redondeados a 6 decimales, que son los que viajan en el XML.
    const gross = dec(six(qty)).mul(dec(six(price)));
    if (discount.gt(gross)) throw new CalculationError(`Línea ${n}: el descuento supera el valor de la línea`);
    const subtotal = money(gross.minus(discount));

    return {
      mainCode: l.mainCode?.trim() || null,
      auxCode: l.auxCode?.trim() || null,
      description: l.description.trim(),
      unit: l.unit?.trim() || null,
      quantity: six(qty),
      unitPrice: six(price),
      discount: money(discount),
      subtotal,
      taxes: l.taxes.map((t) => ({
        taxCode: t.taxCode,
        percentageCode: t.percentageCode,
        rate: rate2(t.rate),
        base: subtotal,
        amount: money(dec(subtotal).mul(dec(t.rate)).div(100)),
      })),
      additional: l.additional ?? [],
    };
  });
}

export function computeInvoice(lines: LineInput[], opts: { tip?: Num } = {}): ComputedInvoice {
  const computed = computeLines(lines);
  const groups = new Map<string, { taxCode: string; percentageCode: string; rate: string; base: Dec }>();
  let subtotal = new D(0);
  let totalDiscount = new D(0);

  for (const line of computed) {
    subtotal = subtotal.plus(line.subtotal);
    totalDiscount = totalDiscount.plus(line.discount);
    for (const t of line.taxes) {
      const key = `${t.taxCode}|${t.percentageCode}|${t.rate}`;
      const g = groups.get(key);
      if (g) g.base = g.base.plus(t.base);
      else groups.set(key, { taxCode: t.taxCode, percentageCode: t.percentageCode, rate: t.rate, base: dec(t.base) });
    }
  }

  const taxGroups: TaxGroup[] = [...groups.values()]
    .sort((a, b) => a.taxCode.localeCompare(b.taxCode) || a.percentageCode.localeCompare(b.percentageCode, undefined, { numeric: true }))
    .map((g) => ({
      taxCode: g.taxCode,
      percentageCode: g.percentageCode,
      rate: g.rate,
      base: money(g.base),
      amount: money(g.base.mul(g.rate).div(100)),
    }));

  const totalTax = taxGroups.reduce((s, g) => s.plus(g.amount), new D(0));
  const tip = dec(opts.tip ?? 0);
  if (tip.lt(0)) throw new CalculationError('La propina no puede ser negativa');
  if (tip.gt(subtotal.mul('0.10'))) throw new CalculationError('La propina no puede superar el 10 % del subtotal');

  return {
    lines: computed,
    totals: {
      subtotal: money(subtotal),
      totalDiscount: money(totalDiscount),
      taxGroups,
      totalTax: money(totalTax),
      tip: money(tip),
      total: money(subtotal.plus(totalTax).plus(tip)),
    },
  };
}

/** Verifica que la suma de las formas de pago cuadre con el total. */
export function assertPaymentsMatch(payments: { amount: Num }[], total: Num): void {
  if (payments.length === 0) throw new CalculationError('Indique al menos una forma de pago');
  const sum = payments.reduce((s, p) => s.plus(dec(p.amount)), new D(0));
  if (!sum.toDecimalPlaces(2).eq(dec(total).toDecimalPlaces(2))) {
    throw new CalculationError(`Las formas de pago suman ${money(sum)} y el total es ${money(total)}`);
  }
}

/**
 * Reparte un descuento global (en centavos) entre las líneas en proporción a su valor bruto,
 * porque el XML del SRI lleva el descuento por línea. El residuo del redondeo se asigna, centavo
 * a centavo, a las líneas de mayor valor. Nunca asigna a una línea más que su propio valor.
 */
export function distributeDiscount(grossCents: number[], discountCents: number): number[] {
  const total = grossCents.reduce((a, b) => a + b, 0);
  if (total <= 0 || discountCents <= 0) return grossCents.map(() => 0);
  if (discountCents > total) throw new CalculationError('El descuento supera el total');
  const parts = grossCents.map((g) => Math.floor((g * discountCents) / total));
  let rest = discountCents - parts.reduce((a, b) => a + b, 0);
  const order = grossCents.map((g, i) => [g, i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; rest > 0; k = (k + 1) % order.length) {
    const i = order[k][1];
    if (parts[i] < grossCents[i]) {
      parts[i]++;
      rest--;
    }
  }
  return parts;
}
