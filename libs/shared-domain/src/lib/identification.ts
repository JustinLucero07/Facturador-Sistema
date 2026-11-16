/**
 * Validación de identificaciones ecuatorianas (cédula y RUC).
 *
 * - Cédula (10 dígitos): provincia 01–24 o 30 (ecuatorianos en el exterior), tercer dígito 0–5,
 *   dígito verificador módulo 10 con coeficientes 2.1.2.1.2.1.2.1.2.
 * - RUC persona natural: cédula válida + establecimiento de 3 dígitos distinto de 000.
 * - RUC sociedad privada / extranjeros (tercer dígito 9): módulo 11, coeficientes 4.3.2.7.6.5.4.3.2,
 *   verificador en la posición 10 + establecimiento de 3 dígitos ≠ 000.
 * - RUC entidad pública (tercer dígito 6): módulo 11, coeficientes 3.2.7.6.5.4.3.2,
 *   verificador en la posición 9 + establecimiento de 4 dígitos ≠ 0000.
 *
 * Nota: el SRI ha emitido RUC de sociedades que no cumplen el módulo 11. Por eso, para sociedades
 * privadas el fallo del verificador se reporta como advertencia (`checkDigitWarning`) y NO invalida.
 */

export type IdentificationKind =
  | 'CEDULA'
  | 'RUC_NATURAL'
  | 'RUC_PRIVATE'
  | 'RUC_PUBLIC'
  | 'FINAL_CONSUMER';

export interface IdentificationResult {
  valid: boolean;
  kind?: IdentificationKind;
  /** Mensaje en español para mostrar al usuario cuando no es válida. */
  error?: string;
  /** Verdadero cuando el RUC de sociedad no cumple módulo 11 pero se acepta. */
  checkDigitWarning?: boolean;
}

export const FINAL_CONSUMER_ID = '9999999999999';

const digitsOnly = /^\d+$/;

function provinceOk(id: string): boolean {
  const province = Number(id.slice(0, 2));
  return (province >= 1 && province <= 24) || province === 30;
}

function mod10CheckDigit(first9: string): number {
  const coefficients = [2, 1, 2, 1, 2, 1, 2, 1, 2];
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let product = Number(first9[i]) * coefficients[i];
    if (product > 9) product -= 9;
    sum += product;
  }
  return (10 - (sum % 10)) % 10;
}

function mod11CheckDigit(digits: string, coefficients: number[]): number | null {
  let sum = 0;
  for (let i = 0; i < coefficients.length; i++) sum += Number(digits[i]) * coefficients[i];
  const remainder = sum % 11;
  if (remainder === 0) return 0;
  const check = 11 - remainder;
  return check === 10 ? null : check;
}

export function validateCedula(id: string): IdentificationResult {
  if (!digitsOnly.test(id) || id.length !== 10) {
    return { valid: false, error: 'La cédula debe tener 10 dígitos.' };
  }
  if (!provinceOk(id)) return { valid: false, error: 'Código de provincia inválido.' };
  if (Number(id[2]) > 5) return { valid: false, error: 'El tercer dígito de la cédula es inválido.' };
  if (mod10CheckDigit(id.slice(0, 9)) !== Number(id[9])) {
    return { valid: false, error: 'El dígito verificador de la cédula es incorrecto.' };
  }
  return { valid: true, kind: 'CEDULA' };
}

export function validateRuc(ruc: string): IdentificationResult {
  if (ruc === FINAL_CONSUMER_ID) return { valid: true, kind: 'FINAL_CONSUMER' };
  if (!digitsOnly.test(ruc) || ruc.length !== 13) {
    return { valid: false, error: 'El RUC debe tener 13 dígitos.' };
  }
  if (!provinceOk(ruc)) return { valid: false, error: 'Código de provincia inválido.' };

  const third = Number(ruc[2]);

  if (third < 6) {
    const cedula = validateCedula(ruc.slice(0, 10));
    if (!cedula.valid) return { valid: false, error: cedula.error?.replace('cédula', 'RUC') };
    if (ruc.slice(10) === '000') return { valid: false, error: 'El código de establecimiento del RUC es inválido.' };
    return { valid: true, kind: 'RUC_NATURAL' };
  }

  if (third === 6) {
    if (ruc.slice(9) === '0000') return { valid: false, error: 'El código de establecimiento del RUC es inválido.' };
    const check = mod11CheckDigit(ruc, [3, 2, 7, 6, 5, 4, 3, 2]);
    if (check === null || check !== Number(ruc[8])) {
      return { valid: false, error: 'El dígito verificador del RUC público es incorrecto.' };
    }
    return { valid: true, kind: 'RUC_PUBLIC' };
  }

  if (third === 9) {
    if (ruc.slice(10) === '000') return { valid: false, error: 'El código de establecimiento del RUC es inválido.' };
    const check = mod11CheckDigit(ruc, [4, 3, 2, 7, 6, 5, 4, 3, 2]);
    const checkDigitWarning = check === null || check !== Number(ruc[9]);
    return { valid: true, kind: 'RUC_PRIVATE', ...(checkDigitWarning ? { checkDigitWarning } : {}) };
  }

  return { valid: false, error: 'El tercer dígito del RUC es inválido.' };
}

/** Valida según longitud: 10 → cédula, 13 → RUC. */
export function validateIdentification(id: string): IdentificationResult {
  const clean = id.trim();
  if (clean.length === 10) return validateCedula(clean);
  if (clean.length === 13) return validateRuc(clean);
  return { valid: false, error: 'La identificación debe tener 10 (cédula) o 13 (RUC) dígitos.' };
}
