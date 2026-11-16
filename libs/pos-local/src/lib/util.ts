import Decimal from 'decimal.js';

export const D = Decimal.clone({ rounding: Decimal.ROUND_HALF_UP });
export const m2 = (v: Decimal.Value) => new D(v || 0).toFixed(2);
/** Cantidad sin ceros sobrantes ("2.500000" → "2.5"). */
export const qty = (v: Decimal.Value) => new D(v || 0).toDecimalPlaces(6).toString();

/** Error con código HTTP y mensaje para el usuario (en español). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: string[],
  ) {
    super(message);
  }
}

export const unprocessable = (message: string, details?: string[]) => new HttpError(422, message, details);
export const notFound = (message: string) => new HttpError(404, message);
export const forbidden = (message = 'No tiene permiso para realizar esta acción') => new HttpError(403, message);

/** Fecha calendario en Ecuador continental (misma regla que el servidor). */
export function ecuadorDate(now = new Date()): { day: number; month: number; year: number } {
  const [year, month, day] = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now)
    .split('-')
    .map(Number);
  return { day, month, year };
}

export const formatSequential = (v: number | bigint) => v.toString().padStart(9, '0');

export const json = <T>(v: string | null | undefined, fallback: T): T => {
  if (!v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

/** Normaliza para buscar sin tildes ni mayúsculas. */
export const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
