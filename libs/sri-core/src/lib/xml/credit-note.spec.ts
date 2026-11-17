import { computeInvoice, creditLine, CalculationError } from '../calc';
import { validateAgainstXsd } from '../xsd/validate';
import { buildAccessKey } from '../access-key';
import { buildCreditNoteXml, CreditNoteDocument } from './credit-note';

const iva15 = { taxCode: '2', percentageCode: '4', rate: '15' };
const src = { mainCode: 'MART', description: 'Martillo', quantity: '3', unitPrice: '10.000000', discount: '1.00', taxes: [iva15], creditedQuantity: '0', creditedDiscount: '0' };

describe('creditLine (devoluciones)', () => {
  it('prorratea el descuento y usa el saldo exacto en la última devolución', () => {
    expect(creditLine(src, '1').discount).toBe('0.33');
    expect(creditLine({ ...src, creditedQuantity: '1', creditedDiscount: '0.33' }, '1').discount).toBe('0.33');
    expect(creditLine({ ...src, creditedQuantity: '2', creditedDiscount: '0.66' }, '1').discount).toBe('0.34');
  });
  it('no permite devolver más de lo facturado menos lo ya devuelto', () => {
    expect(() => creditLine({ ...src, creditedQuantity: '2' }, '2')).toThrow(CalculationError);
    expect(() => creditLine(src, '0')).toThrow(/mayor a cero/);
  });
  it('tres devoluciones parciales suman exactamente la factura', () => {
    const inv = computeInvoice([{ ...src, taxes: [iva15] }]).totals.total;
    let cq = '0';
    let cd = '0';
    let sum = 0;
    for (let k = 0; k < 3; k++) {
      const l = creditLine({ ...src, creditedQuantity: cq, creditedDiscount: cd }, '1');
      sum += Number(computeInvoice([l]).totals.total);
      cq = String(Number(cq) + 1);
      cd = (Number(cd) + Number(l.discount)).toFixed(2);
    }
    expect(sum.toFixed(2)).toBe(inv);
  });
});

describe('XML de la nota de crédito', () => {
  const computed = computeInvoice([creditLine(src, '2')]);
  const doc: CreditNoteDocument = {
    version: '1.1.0',
    environment: 1,
    accessKey: buildAccessKey({ issueDate: { day: 16, month: 11, year: 2026 }, docType: '04', ruc: '1790012345001', environment: 1, establishment: '001', emissionPoint: '001', sequential: 1, numericCode: '12345678' }),
    establishment: '001',
    emissionPoint: '001',
    sequential: '1',
    issueDate: { day: 16, month: 11, year: 2026 },
    issuer: { ruc: '1790012345001', legalName: 'FERRETERIA DEMO S.A.', mainAddress: 'Cuenca', keepsAccounting: false, rimpeLegend: 'CONTRIBUYENTE RÉGIMEN RIMPE' },
    buyer: { idType: '05', id: '1710034065', name: 'Cliente de prueba' },
    modified: { docType: '01', number: '001-001-000000007', issueDate: { day: 10, month: 11, year: 2026 } },
    reason: 'Devolución de mercadería',
    lines: computed.lines,
    totals: computed.totals,
    additionalInfo: [{ name: 'Reembolso', value: 'Efectivo' }],
    currency: 'DOLAR',
  };

  it('cumple el XSD oficial NotaCredito_V1.1.0', async () => {
    const xml = buildCreditNoteXml(doc);
    expect(xml).toContain('<codDoc>04</codDoc>');
    expect(xml).toContain('<numDocModificado>001-001-000000007</numDocModificado>');
    expect(xml).toContain(`<valorModificacion>${computed.totals.total}</valorModificacion>`);
    const r = await validateAgainstXsd(xml, 'notaCredito', '1.1.0');
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it('rechaza consumidor final como receptor (Ficha, Tabla 6)', () => {
    expect(() => buildCreditNoteXml({ ...doc, buyer: { idType: '07', id: '9999999999999', name: 'CONSUMIDOR FINAL' } })).toThrow(/identificar al cliente/);
  });
});

describe('Lectura y RIDE de la nota de crédito', () => {
  it('el XML se vuelve a leer igual y genera un PDF', async () => {
    const { parseCreditNoteXml } = await import('./parse-invoice');
    const { renderCreditNoteRide } = await import('../ride/ride');
    const computed = computeInvoice([creditLine(src, '1')]);
    const base = {
      version: '1.1.0', environment: 1 as const, accessKey: '1'.repeat(49), establishment: '001', emissionPoint: '001', sequential: '000000002',
      issueDate: { day: 16, month: 11, year: 2026 }, issuer: { ruc: '1790012345001', legalName: 'X S.A.', mainAddress: 'Cuenca', keepsAccounting: true },
      buyer: { idType: '05', id: '1710034065', name: 'Cliente' }, modified: { docType: '01', number: '001-001-000000007', issueDate: { day: 10, month: 11, year: 2026 } },
      reason: 'Producto defectuoso', lines: computed.lines, totals: computed.totals, additionalInfo: [], currency: 'DOLAR',
    };
    const back = parseCreditNoteXml(buildCreditNoteXml(base));
    expect(back.modified).toEqual(base.modified);
    expect(back.reason).toBe('Producto defectuoso');
    expect(back.totals.total).toBe(computed.totals.total);
    expect(back.lines[0]).toMatchObject({ mainCode: 'MART', quantity: computed.lines[0].quantity, discount: computed.lines[0].discount });
    const pdf = await renderCreditNoteRide(back, { rateLabels: { '4': '15%' }, paymentLabels: {} });
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  });
});
