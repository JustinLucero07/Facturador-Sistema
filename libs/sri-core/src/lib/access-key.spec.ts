import { buildAccessKey, isValidAccessKey, mod11CheckDigit, parseAccessKey } from './access-key';

describe('módulo 11 (Ficha Técnica v2.34, numeral 5.2)', () => {
  it('ejemplo de la ficha: 41261533 → 6', () => {
    expect(mod11CheckDigit('41261533')).toBe(6);
  });

  it.each([
    // Claves de ejemplo publicadas en la ficha (respuestas de los WS y formato de lote)
    '0503201201176001321000110010030009900641234567814',
    '1702201205176001321000110010030001000011234567816',
    '1302201201176001321000120010030000050431234567814',
    '2808201400179210439400110010010000000091234567812',
  ])('valida la clave oficial %s', (key) => {
    expect(isValidAccessKey(key)).toBe(true);
  });

  it('resultado 11 → 0 y resultado 10 → 1', () => {
    // Suma ponderada múltiplo de 11 → 11 - 0 = 11 → 0
    expect(mod11CheckDigit('0')).toBe(0);
    // "4": 4*2 = 8 → 11-8 = 3 ; "5": 10 → 11-10 = 1 ; "6": 12 → 11-1 = 10 → 1
    expect(mod11CheckDigit('4')).toBe(3);
    expect(mod11CheckDigit('6')).toBe(1);
  });

  it('rechaza caracteres no numéricos', () => {
    expect(() => mod11CheckDigit('12a')).toThrow();
  });
});

describe('buildAccessKey', () => {
  const base = {
    issueDate: { day: 5, month: 3, year: 2012 },
    docType: '01',
    ruc: '1760013210001',
    environment: 1 as const,
    establishment: '001',
    emissionPoint: '003',
    sequential: 990064,
    numericCode: '12345678',
  };

  it('reproduce la clave del ejemplo de la ficha (Anexo 14)', () => {
    expect(buildAccessKey(base)).toBe('0503201201176001321000110010030009900641234567814');
  });

  it('genera 49 dígitos con código numérico aleatorio y DV válido', () => {
    const { numericCode: _, ...rest } = base;
    const key = buildAccessKey(rest);
    expect(key).toHaveLength(49);
    expect(isValidAccessKey(key)).toBe(true);
    expect(parseAccessKey(key).emissionType).toBe('1');
  });

  it('acepta secuencial bigint', () => {
    expect(parseAccessKey(buildAccessKey({ ...base, sequential: 51n })).sequential).toBe('000000051');
  });

  it('rechaza componentes con longitud incorrecta', () => {
    expect(() => buildAccessKey({ ...base, ruc: '176001321000' })).toThrow(/RUC/);
    expect(() => buildAccessKey({ ...base, establishment: '1' })).toThrow(/serie/);
    expect(() => buildAccessKey({ ...base, sequential: 1_000_000_000 })).toThrow(/secuencial/);
  });

  it('parseAccessKey separa los campos', () => {
    expect(parseAccessKey('0503201201176001321000110010030009900641234567814')).toEqual({
      issueDate: '05032012',
      docType: '01',
      ruc: '1760013210001',
      environment: '1',
      establishment: '001',
      emissionPoint: '003',
      sequential: '000990064',
      numericCode: '12345678',
      emissionType: '1',
      checkDigit: '4',
    });
  });
});
