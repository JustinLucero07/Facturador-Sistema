import { randomInt } from 'node:crypto';

/**
 * Clave de acceso de 49 dígitos — Ficha Técnica offline v2.34, numeral 5.2, Tabla 1:
 *   fecha ddmmaaaa (8) + tipo comprobante (2) + RUC (13) + ambiente (1) + serie (6)
 *   + secuencial (9) + código numérico (8) + tipo de emisión (1) + dígito verificador módulo 11 (1).
 * En el esquema offline el tipo de emisión siempre es 1 (Tabla 2).
 */
export interface AccessKeyParts {
  /** Fecha de emisión (se toma día/mes/año tal como se indican, sin conversión de zona). */
  issueDate: { day: number; month: number; year: number };
  /** Tabla 3: 01 factura, 03 liquidación, 04 NC, 05 ND, 06 guía, 07 retención */
  docType: string;
  ruc: string;
  /** Tabla 4: 1 pruebas, 2 producción */
  environment: 1 | 2;
  establishment: string;
  emissionPoint: string;
  sequential: string | number | bigint;
  /** 8 dígitos; si se omite se genera aleatoriamente. */
  numericCode?: string;
  emissionType?: '1';
}

const pad = (v: string | number | bigint, n: number) => v.toString().padStart(n, '0');

/**
 * Módulo 11 con factor de chequeo ponderado 2..7 desde la derecha.
 * Resultado 11 → 0; resultado 10 → 1 (numeral 5.2).
 */
export function mod11CheckDigit(digits: string): number {
  if (!/^\d+$/.test(digits)) throw new Error('El módulo 11 solo admite dígitos');
  let sum = 0;
  let weight = 2;
  for (let i = digits.length - 1; i >= 0; i--) {
    sum += Number(digits[i]) * weight;
    weight = weight === 7 ? 2 : weight + 1;
  }
  const result = 11 - (sum % 11);
  if (result === 11) return 0;
  if (result === 10) return 1;
  return result;
}

export function randomNumericCode(): string {
  return pad(randomInt(0, 100_000_000), 8);
}

export function buildAccessKey(p: AccessKeyParts): string {
  const { day, month, year } = p.issueDate;
  const fields: [string, string, number][] = [
    [pad(day, 2) + pad(month, 2) + pad(year, 4), 'fecha', 8],
    [p.docType, 'tipo de comprobante', 2],
    [p.ruc, 'RUC', 13],
    [String(p.environment), 'ambiente', 1],
    [p.establishment + p.emissionPoint, 'serie', 6],
    [pad(p.sequential, 9), 'secuencial', 9],
    [p.numericCode ?? randomNumericCode(), 'código numérico', 8],
    [p.emissionType ?? '1', 'tipo de emisión', 1],
  ];
  for (const [value, label, length] of fields) {
    if (value.length !== length || !/^\d+$/.test(value)) {
      throw new Error(`Clave de acceso: ${label} inválido ("${value}", se esperan ${length} dígitos)`);
    }
  }
  const base = fields.map(([v]) => v).join('');
  return base + mod11CheckDigit(base);
}

export interface ParsedAccessKey {
  issueDate: string;
  docType: string;
  ruc: string;
  environment: string;
  establishment: string;
  emissionPoint: string;
  sequential: string;
  numericCode: string;
  emissionType: string;
  checkDigit: string;
}

export function parseAccessKey(key: string): ParsedAccessKey {
  if (!/^\d{49}$/.test(key)) throw new Error('La clave de acceso debe tener 49 dígitos');
  return {
    issueDate: key.slice(0, 8),
    docType: key.slice(8, 10),
    ruc: key.slice(10, 23),
    environment: key.slice(23, 24),
    establishment: key.slice(24, 27),
    emissionPoint: key.slice(27, 30),
    sequential: key.slice(30, 39),
    numericCode: key.slice(39, 47),
    emissionType: key.slice(47, 48),
    checkDigit: key.slice(48),
  };
}

export function isValidAccessKey(key: string): boolean {
  return /^\d{49}$/.test(key) && mod11CheckDigit(key.slice(0, 48)) === Number(key[48]);
}
