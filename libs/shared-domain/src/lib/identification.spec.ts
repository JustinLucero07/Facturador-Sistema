import { validateCedula, validateIdentification, validateRuc } from './identification';

describe('validateCedula', () => {
  it.each(['1710034065', '0102030400', '0923456784', '3000000012'])('acepta cédula válida %s', (id) => {
    expect(validateCedula(id)).toEqual({ valid: true, kind: 'CEDULA' });
  });

  it('rechaza dígito verificador incorrecto', () => {
    expect(validateCedula('1710034066').valid).toBe(false);
  });

  it('rechaza provincia inválida (25)', () => {
    expect(validateCedula('2510034065').error).toMatch(/provincia/);
  });

  it('rechaza tercer dígito mayor a 5', () => {
    expect(validateCedula('1760034065').valid).toBe(false);
  });

  it('rechaza longitud o caracteres incorrectos', () => {
    expect(validateCedula('171003406').valid).toBe(false);
    expect(validateCedula('17100340AB').valid).toBe(false);
  });
});

describe('validateRuc', () => {
  it('acepta RUC de persona natural', () => {
    expect(validateRuc('1710034065001')).toEqual({ valid: true, kind: 'RUC_NATURAL' });
  });

  it('rechaza RUC natural con establecimiento 000', () => {
    expect(validateRuc('1710034065000').valid).toBe(false);
  });

  it('acepta RUC de entidad pública (SRI: 1760013210001)', () => {
    expect(validateRuc('1760013210001')).toEqual({ valid: true, kind: 'RUC_PUBLIC' });
  });

  it('rechaza RUC público con verificador incorrecto', () => {
    expect(validateRuc('1760013220001').valid).toBe(false);
  });

  it.each(['1790012344001', '0992345675001', '1791234561001'])('acepta RUC de sociedad privada %s', (ruc) => {
    expect(validateRuc(ruc)).toEqual({ valid: true, kind: 'RUC_PRIVATE' });
  });

  it('acepta RUC de sociedad con verificador incorrecto, pero con advertencia', () => {
    expect(validateRuc('1790012345001')).toEqual({ valid: true, kind: 'RUC_PRIVATE', checkDigitWarning: true });
  });

  it('acepta consumidor final', () => {
    expect(validateRuc('9999999999999')).toEqual({ valid: true, kind: 'FINAL_CONSUMER' });
  });

  it('rechaza tercer dígito 7 u 8', () => {
    expect(validateRuc('1770012344001').valid).toBe(false);
  });
});

describe('validateIdentification', () => {
  it('decide por longitud', () => {
    expect(validateIdentification(' 1710034065 ').kind).toBe('CEDULA');
    expect(validateIdentification('1710034065001').kind).toBe('RUC_NATURAL');
    expect(validateIdentification('12345').valid).toBe(false);
  });
});
