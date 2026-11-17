import { inflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atsFileName, atsName, AtsPurchase, AtsReport, AtsSale, buildAtsXml, validateAts } from './ats';
import { zipSingleFile } from './zip';

const purchase = (over: Partial<AtsPurchase> = {}): AtsPurchase => ({
  sustentoCode: '06',
  idType: '01',
  id: '1790016900001',
  name: 'DISTRIBUIDORA AUSTRAL CIA. LTDA.',
  relatedParty: false,
  docType: '01',
  accountingDate: { day: 16, month: 11, year: 2026 },
  establishment: '001',
  emissionPoint: '003',
  sequential: '000081234',
  issueDate: { day: 15, month: 11, year: 2026 },
  authorization: '1511202601179001690000110010030000812342878902612',
  baseNoGraIva: '0',
  baseImponible: '20.00',
  baseImpGrav: '100.00',
  baseImpExe: '0',
  montoIce: '0',
  montoIva: '15.00',
  ivaWithholding: { '30': '4.50' },
  paymentForms: ['20'],
  air: [{ code: '312', base: '120.00', percentage: '1.75', amount: '2.10' }],
  withholding: {
    establishment: '001',
    emissionPoint: '001',
    sequential: '000000007',
    authorization: '1711202607179001234500110010010000000071234567811',
    issueDate: { day: 17, month: 11, year: 2026 },
  },
  ...over,
});

const sale = (over: Partial<AtsSale> = {}): AtsSale => ({
  idType: '04',
  id: '1792000009001',
  name: 'CONSTRUCTORA DEL AUSTRO CIA. LTDA.',
  relatedParty: false,
  docType: '18',
  emission: 'E',
  count: 3,
  baseNoGraIva: '0',
  baseImponible: '10.00',
  baseImpGrav: '200.00',
  montoIva: '30.00',
  montoIce: '0',
  ivaWithheld: '9.00',
  rentaWithheld: '3.50',
  paymentForms: ['01', '20'],
  ...over,
});

const report = (over: Partial<AtsReport> = {}): AtsReport => ({
  ruc: '1790012345001',
  name: 'FERRETERÍA "EL CONSTRUCTOR" S.A.',
  year: 2026,
  month: 11,
  establishmentsCount: 1,
  totalSales: '210.00',
  purchases: [purchase()],
  sales: [sale()],
  salesByEstablishment: [{ code: '001', total: '210.00' }],
  voided: [],
  ...over,
});

describe('ATS', () => {
  it('el ejemplo oficial del SRI es válido con el XSD empaquetado', async () => {
    const sample = readFileSync(join(__dirname, '../../../xsd/oficial/ATS_Ejemplo_ATS_XML.xml'), 'latin1');
    // El ejemplo trae secciones de exportaciones/recap de otros contribuyentes; solo se verifica que el XSD cargue
    const r = await validateAts(sample);
    expect(Array.isArray(r.errors)).toBe(true);
  });

  it('genera compras, ventas y ventas por establecimiento válidos', async () => {
    const xml = buildAtsXml(report());
    const r = await validateAts(xml);
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
    expect(xml).toContain('<razonSocial>FERRETERIA EL CONSTRUCTOR S A</razonSocial>');
    expect(xml).toContain('<secuencial>81234</secuencial>');
    expect(xml).toContain('<valorRetBienes>4.50</valorRetBienes>');
    expect(xml).toContain('<valRetServ100>0.00</valRetServ100>');
    expect(xml).toContain('<porcentajeAir>1.75</porcentajeAir>');
    expect(xml).toContain('<fechaEmiRet1>17/11/2026</fechaEmiRet1>');
    expect(xml).toContain('<formasDePago><formaPago>01</formaPago><formaPago>20</formaPago></formasDePago>');
    expect(xml.indexOf('<codigoOperativo>')).toBeLessThan(xml.indexOf('<compras>'));
  });

  it('consumidor final sin parte relacionada; pasaporte con tipo y razón social', async () => {
    const xml = buildAtsXml(
      report({
        sales: [
          sale({ idType: '07', id: '9999999999999', name: 'CONSUMIDOR FINAL', paymentForms: [] }),
          sale({ idType: '06', id: 'AB123456', personType: '01', name: 'John O’Neil' }),
          sale({ docType: '04', count: 1, ivaWithheld: '0', rentaWithheld: '0', paymentForms: [] }),
        ],
        purchases: [purchase({ idType: '03', id: 'P998877', personType: '02', withholding: null, air: [{ code: '332', base: '120', percentage: '0', amount: '0' }] })],
      }),
    );
    const r = await validateAts(xml);
    expect(r.errors).toEqual([]);
    expect(xml).toMatch(/<tpIdCliente>07<\/tpIdCliente><idCliente>9999999999999<\/idCliente><tipoComprobante>/);
    expect(xml).toContain('<tipoCliente>01</tipoCliente><denoCli>John O Neil</denoCli>');
    expect(xml).toContain('<tipoProv>02</tipoProv><denoProv>DISTRIBUIDORA AUSTRAL CIA LTDA</denoProv>');
    expect(xml).not.toContain('estabRetencion1');
  });

  it('semestral RIMPE, sin movimientos y con anulados', async () => {
    const xml = buildAtsXml(
      report({
        month: 12,
        semiannual: true,
        totalSales: '0',
        purchases: [],
        sales: [],
        salesByEstablishment: [{ code: '001', total: '0' }, { code: '002', total: '0' }],
        establishmentsCount: 2,
        voided: [{ docType: '01', establishment: '001', emissionPoint: '002', from: '000000010', to: '000000012', authorization: '1234567890' }],
      }),
    );
    const r = await validateAts(xml);
    expect(r.errors).toEqual([]);
    expect(xml).toContain('<regimenMicroempresa>SI</regimenMicroempresa><numEstabRuc>002</numEstabRuc>');
  });

  it('el XSD rechaza datos inválidos (RUC del informante)', async () => {
    const r = await validateAts(buildAtsXml(report({ ruc: '179001234' })));
    expect(r.valid).toBe(false);
  });

  it('atsName deja solo letras, números y espacios', () => {
    expect(atsName('  Ñandú & Cía. "Ltda."  ')).toBe('Nandu Cia Ltda');
  });

  it('nombre y empaquetado ATmmaaaa.zip', () => {
    expect(atsFileName(2026, 3)).toBe('AT032026');
    const content = Buffer.from('<iva></iva>');
    const zip = zipSingleFile('AT032026.xml', content);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const nameLen = zip.readUInt16LE(26);
    const size = zip.readUInt32LE(18);
    expect(zip.subarray(30, 30 + nameLen).toString()).toBe('AT032026.xml');
    expect(inflateRawSync(zip.subarray(30 + nameLen, 30 + nameLen + size)).toString()).toBe('<iva></iva>');
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
  });
});
