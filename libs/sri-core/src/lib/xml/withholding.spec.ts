import { buildAccessKey } from '../access-key';
import { validateAgainstXsd } from '../xsd/validate';
import { buildWithholdingXml, WithholdingDocument, withholdingAmount } from './withholding';

const doc = (over: Partial<WithholdingDocument> = {}): WithholdingDocument => ({
  version: '2.0.0',
  environment: 1,
  accessKey: buildAccessKey({ issueDate: { day: 17, month: 11, year: 2026 }, docType: '07', ruc: '1790012345001', environment: 1, establishment: '001', emissionPoint: '001', sequential: 1, numericCode: '12345678' }),
  establishment: '001',
  emissionPoint: '001',
  sequential: '000000001',
  issueDate: { day: 17, month: 11, year: 2026 },
  issuer: { ruc: '1790012345001', legalName: 'FERRETERIA DEMO S.A.', mainAddress: 'Cuenca', keepsAccounting: true, withholdingAgentNumber: '00001' },
  subject: { idType: '04', id: '1790016900001', name: 'DISTRIBUIDORA AUSTRAL CIA. LTDA.', relatedParty: false },
  fiscalPeriod: { month: 11, year: 2026 },
  support: {
    sustentoCode: '06',
    docType: '01',
    number: '001-003-000081234',
    issueDate: { day: 15, month: 11, year: 2026 },
    authorization: '1511202601179001690000110010030000812342878902612',
    subtotal: '100.00',
    total: '115.00',
    taxes: [{ taxCode: '2', percentageCode: '4', base: '100.00', rate: '15.00', amount: '15.00' }],
    payments: [{ code: '20', amount: '115.00' }],
  },
  items: [
    { tax: '1', code: '312', base: '100.00', percentage: '2.00', amount: withholdingAmount('100.00', '2') },
    { tax: '2', code: '1', base: '15.00', percentage: '30', amount: withholdingAmount('15.00', '30') },
  ],
  additionalInfo: [{ name: 'Email', value: 'proveedor@example.com' }],
  ...over,
});

describe('Comprobante de retención v2.0.0', () => {
  it('valor retenido redondeado a centavos', () => {
    expect(withholdingAmount('100.00', '2')).toBe('2.00');
    expect(withholdingAmount('15.00', '30')).toBe('4.50');
    expect(withholdingAmount('125.90', '1.75')).toBe('2.20');
  });

  it('cumple el XSD oficial ComprobanteRetencion_V2.0.0', async () => {
    const xml = buildWithholdingXml(doc());
    expect(xml).toContain('<codDoc>07</codDoc>');
    expect(xml).toContain('<numDocSustento>001003000081234</numDocSustento>');
    expect(xml).toContain('<porcentajeRetener>2</porcentajeRetener>');
    expect(xml).toContain('<periodoFiscal>11/2026</periodoFiscal>');
    const r = await validateAgainstXsd(xml, 'comprobanteRetencion', '2.0.0');
    expect(r.errors).toEqual([]);
  });

  it('porcentajes con decimales (1.75) y retención de IVA 100 % también son válidos', async () => {
    const xml = buildWithholdingXml(
      doc({ items: [{ tax: '1', code: '312C', base: '100.00', percentage: '1.75', amount: '1.75' }, { tax: '2', code: '3', base: '15.00', percentage: '100', amount: '15.00' }] }),
    );
    expect((await validateAgainstXsd(xml, 'comprobanteRetencion', '2.0.0')).errors).toEqual([]);
  });

  it('no admite consumidor final ni números de sustento mal formados', () => {
    expect(() => buildWithholdingXml(doc({ subject: { idType: '07', id: '9999999999999', name: 'X', relatedParty: false } }))).toThrow(/sujeto retenido/);
    expect(() => buildWithholdingXml(doc({ support: { ...doc().support, number: '123' } }))).toThrow(/sustento/);
  });
});

describe('Lectura y RIDE del comprobante de retención', () => {
  it('se vuelve a leer igual y genera el PDF', async () => {
    const { parseWithholdingXml } = await import('./parse-invoice');
    const { renderWithholdingRide } = await import('../ride/ride');
    const back = parseWithholdingXml(buildWithholdingXml(doc()));
    expect(back.support.number).toBe('001-003-000081234');
    expect(back.items).toEqual([
      { tax: '1', code: '312', base: '100.00', percentage: '2', amount: '2.00' },
      { tax: '2', code: '1', base: '15.00', percentage: '30', amount: '4.50' },
    ]);
    expect(back.subject).toMatchObject({ id: '1790016900001', relatedParty: false });
    const pdf = await renderWithholdingRide(back, {});
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  });
});
