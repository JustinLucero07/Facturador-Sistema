import Decimal from 'decimal.js';

/** Decimal con redondeo comercial (ROUND_HALF_UP), sin depender de la configuración global. */
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Dec = InstanceType<typeof D>;
export type Num = string | number | Dec;

export const dec = (v: Num): Dec => new D(v as Decimal.Value);

/** Montos: 2 decimales (numeral 9.17). */
export const money = (v: Num): string => dec(v).toDecimalPlaces(2).toFixed(2);

/** Cantidad y precio unitario: hasta 6 decimales (versión 1.1.0). */
export const six = (v: Num): string => dec(v).toDecimalPlaces(6).toFixed(6);

/** Tarifa del impuesto con 2 decimales (ej. "15.00"). */
export const rate2 = (v: Num): string => dec(v).toDecimalPlaces(2).toFixed(2);
