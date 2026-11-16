import { isEntry, nextAverageCost, toBaseUnits } from './cost';

describe('costo promedio ponderado', () => {
  it('ejemplo clásico: 10 u a $2,00 + 30 u a $3,00 → $2,75', () => {
    expect(nextAverageCost(10, '2', 30, '3')).toBe('2.750000');
  });

  it('primera entrada: el promedio es el costo de la entrada', () => {
    expect(nextAverageCost(0, 0, 5, '4.123456')).toBe('4.123456');
  });

  it('con existencia negativa (se vendió sin stock) el promedio se reinicia al costo de entrada', () => {
    expect(nextAverageCost(-3, '9.99', 10, '5')).toBe('5.000000');
  });

  it('cantidades con decimales (venta por kilo)', () => {
    // 2,5 kg a $1,20 + 7,5 kg a $1,60 = (3 + 12) / 10 = 1,50
    expect(nextAverageCost('2.5', '1.2', '7.5', '1.6')).toBe('1.500000');
  });

  it('una salida no cambia el promedio', () => {
    expect(nextAverageCost(10, '2.75', -4, '0')).toBe('2.750000');
  });

  it('redondea a 6 decimales half-up', () => {
    // (1×1 + 2×2) / 3 = 1,666666… → 1,666667
    expect(nextAverageCost(1, 1, 2, 2)).toBe('1.666667');
  });
});

describe('conversiones', () => {
  it('3 cajas de 12 = 36 unidades', () => {
    expect(toBaseUnits(3, 12)).toBe('36.000000');
  });
  it('medio metro de un rollo de 100 m', () => {
    expect(toBaseUnits('0.5', 1)).toBe('0.500000');
  });
});

describe('tipos de movimiento', () => {
  it('clasifica entradas y salidas', () => {
    expect(isEntry('PURCHASE')).toBe(true);
    expect(isEntry('TRANSFER_IN')).toBe(true);
    expect(isEntry('SALE')).toBe(false);
    expect(isEntry('ADJUSTMENT_OUT')).toBe(false);
  });
});
