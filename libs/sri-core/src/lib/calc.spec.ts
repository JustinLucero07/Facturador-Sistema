import { assertPaymentsMatch, CalculationError, computeInvoice } from './calc';

const IVA15 = { taxCode: '2', percentageCode: '4', rate: 15 };
const IVA5 = { taxCode: '2', percentageCode: '5', rate: 5 };
const IVA0 = { taxCode: '2', percentageCode: '0', rate: 0 };

describe('computeInvoice', () => {
  it('reproduce el ejemplo del RIDE de la ficha (Anexo 2): 5 % + 15 % + tarifa especial', () => {
    // Anexo 2: IVA5 100,00 ; IVA15 180,00 + 50,00 = 230,00 → IVA 5 % 5,00 ; IVA 15 % 34,50 ; total 369,50
    const r = computeInvoice([
      { description: 'IVA5', quantity: 1, unitPrice: '100.00', taxes: [IVA5] },
      { description: 'IVA15', quantity: 1, unitPrice: '180.00', taxes: [IVA15] },
      { description: 'IVA15ESP', quantity: 1, unitPrice: '50.00', taxes: [IVA15] },
    ]);
    expect(r.totals.subtotal).toBe('330.00');
    expect(r.totals.taxGroups).toEqual([
      { taxCode: '2', percentageCode: '4', rate: '15.00', base: '230.00', amount: '34.50' },
      { taxCode: '2', percentageCode: '5', rate: '5.00', base: '100.00', amount: '5.00' },
    ]);
    expect(r.totals.total).toBe('369.50');
  });

  it('calcula IVA sobre la base agrupada (Tabla 21), no sumando redondeos por línea', () => {
    // 3 líneas de 0,03 al 15 %: por línea 0,0045 → 0,00 c/u; agrupado 0,09 × 15 % = 0,0135 → 0,01
    const r = computeInvoice(Array.from({ length: 3 }, () => ({ description: 'Clavo', quantity: 1, unitPrice: '0.03', taxes: [IVA15] })));
    expect(r.lines.every((l) => l.taxes[0].amount === '0.00')).toBe(true);
    expect(r.totals.taxGroups[0]).toMatchObject({ base: '0.09', amount: '0.01' });
    expect(r.totals.total).toBe('0.10');
  });

  it('cantidades y precios con 6 decimales, descuentos y redondeo half-up', () => {
    const r = computeInvoice([{ description: 'Cable #12 (metro)', quantity: '2.5', unitPrice: '0.456789', discount: '0.10', taxes: [IVA15] }]);
    const l = r.lines[0];
    expect(l.quantity).toBe('2.500000');
    expect(l.unitPrice).toBe('0.456789');
    // 2,5 × 0,456789 = 1,1419725 − 0,10 = 1,0419725 → 1,04
    expect(l.subtotal).toBe('1.04');
    expect(r.totals.totalDiscount).toBe('0.10');
    expect(r.totals.taxGroups[0].amount).toBe('0.16'); // 1,04 × 15 % = 0,156
  });

  it('separa 0 % del 15 %', () => {
    const r = computeInvoice([
      { description: 'Pan', quantity: 2, unitPrice: '0.25', taxes: [IVA0] },
      { description: 'Gaseosa', quantity: 1, unitPrice: '1.00', taxes: [IVA15] },
    ]);
    expect(r.totals.taxGroups.map((g) => [g.percentageCode, g.base, g.amount])).toEqual([
      ['0', '0.50', '0.00'],
      ['4', '1.00', '0.15'],
    ]);
    expect(r.totals.total).toBe('1.65');
  });

  it('usa la tarifa recibida (configurable): un 13 % hipotético funciona sin cambiar código', () => {
    const r = computeInvoice([{ description: 'X', quantity: 1, unitPrice: 100, taxes: [{ taxCode: '2', percentageCode: '10', rate: 13 }] }]);
    expect(r.totals.total).toBe('113.00');
  });

  it('propina máxima 10 % del subtotal', () => {
    expect(computeInvoice([{ description: 'Almuerzo', quantity: 1, unitPrice: 10, taxes: [IVA15] }], { tip: 1 }).totals.total).toBe('12.50');
    expect(() => computeInvoice([{ description: 'Almuerzo', quantity: 1, unitPrice: 10, taxes: [IVA15] }], { tip: '1.01' })).toThrow(/10 %/);
  });

  it.each([
    [{ description: 'X', quantity: 0, unitPrice: 1, taxes: [IVA15] }, /cantidad/],
    [{ description: 'X', quantity: 1, unitPrice: -1, taxes: [IVA15] }, /precio/],
    [{ description: 'X', quantity: 1, unitPrice: 1, discount: 2, taxes: [IVA15] }, /descuento supera/],
    [{ description: ' ', quantity: 1, unitPrice: 1, taxes: [IVA15] }, /descripción/],
    [{ description: 'X', quantity: 1, unitPrice: 1, taxes: [] }, /impuesto/],
  ])('valida datos de línea (%#)', (line, msg) => {
    expect(() => computeInvoice([line])).toThrow(msg);
  });

  it('exige al menos una línea', () => {
    expect(() => computeInvoice([])).toThrow(CalculationError);
  });
});

describe('assertPaymentsMatch', () => {
  it('acepta pagos mixtos que cuadran', () => {
    expect(() => assertPaymentsMatch([{ amount: '10.00' }, { amount: '2.50' }], '12.50')).not.toThrow();
  });
  it('rechaza diferencias', () => {
    expect(() => assertPaymentsMatch([{ amount: '10.00' }], '12.50')).toThrow(/suman 10.00/);
  });
});
