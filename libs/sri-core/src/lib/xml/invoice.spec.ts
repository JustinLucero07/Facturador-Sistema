import { validateXML } from 'xmllint-wasm';
import { sampleInvoice } from '../testing/fixtures';
import { validateAgainstXsd } from '../xsd/validate';
import { buildInvoiceXml } from './invoice';

describe('XML de factura', () => {
  it('cumple el XSD oficial 1.1.0', async () => {
    const xml = buildInvoiceXml(sampleInvoice());
    const r = await validateAgainstXsd(xml, 'factura', '1.1.0');
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it('cumple también el XSD 2.1.0 (versión configurable)', async () => {
    const r = await validateAgainstXsd(buildInvoiceXml(sampleInvoice({ version: '2.1.0' })), 'factura', '2.1.0');
    expect(r.valid).toBe(true);
  });

  it('se genera ya en forma canónica C14N (lo que se firma es exactamente lo que se envía)', async () => {
    const xml = buildInvoiceXml(sampleInvoice());
    const r = await validateXML({ xml: [{ fileName: 'a.xml', contents: xml }], normalization: 'c14n' });
    expect(r.normalized.trim()).toBe(xml);
  });

  it('escapa & y comillas en textos y atributos', () => {
    const xml = buildInvoiceXml(sampleInvoice({ additionalInfo: [{ name: 'Obs "A&B"', value: 'x < y & z' }] }));
    expect(xml).toContain('<descripcion>Martillo de uña 16 oz &amp; mango "fibra"</descripcion>');
    expect(xml).toContain('<campoAdicional nombre="Obs &quot;A&amp;B&quot;">x &lt; y &amp; z</campoAdicional>');
  });

  it('incluye leyendas de agente de retención y RIMPE (Anexos 21 y 22) en el orden del XSD', async () => {
    const base = sampleInvoice();
    for (const legend of ['CONTRIBUYENTE RÉGIMEN RIMPE', 'CONTRIBUYENTE NEGOCIO POPULAR - RÉGIMEN RIMPE']) {
      const xml = buildInvoiceXml({ ...base, issuer: { ...base.issuer, withholdingAgentNumber: '00001', rimpeLegend: legend } });
      expect(xml).toContain(`<agenteRetencion>1</agenteRetencion><contribuyenteRimpe>${legend}</contribuyenteRimpe></infoTributaria>`);
      expect((await validateAgainstXsd(xml, 'factura', '1.1.0')).valid).toBe(true);
    }
  });

  it('el XSD detecta errores de estructura antes de firmar', async () => {
    const doc = sampleInvoice();
    const r = await validateAgainstXsd(buildInvoiceXml({ ...doc, issuer: { ...doc.issuer, ruc: '123' } }), 'factura', '1.1.0');
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/ruc/);
  });

  it('formato de fecha dd/mm/aaaa y secuencial de 9 dígitos', () => {
    const xml = buildInvoiceXml(sampleInvoice());
    expect(xml).toContain('<fechaEmision>16/11/2026</fechaEmision>');
    expect(xml).toContain('<secuencial>000000001</secuencial>');
    expect(xml.startsWith('<factura id="comprobante" version="1.1.0">')).toBe(true);
  });
});

describe('parseInvoiceXml (ida y vuelta)', () => {
  it('reconstruye exactamente el mismo modelo desde el XML', async () => {
    const { parseInvoiceXml } = await import('./parse-invoice');
    const original = sampleInvoice();
    const parsed = parseInvoiceXml(buildInvoiceXml(original));
    // Lo esencial: regenerar el XML desde lo leído produce exactamente el mismo texto.
    expect(buildInvoiceXml(parsed)).toBe(buildInvoiceXml(original));
    expect(parsed.lines).toEqual(original.lines);
    expect(parsed.totals).toEqual(original.totals);
    expect(parsed.sequential).toBe('000000001');
  });

  it('lee el comprobante desde un XML autorizado (CDATA)', async () => {
    const { parseInvoiceXml } = await import('./parse-invoice');
    const xml = buildInvoiceXml(sampleInvoice());
    const authorized = `<?xml version="1.0" encoding="UTF-8"?><autorizacion><estado>AUTORIZADO</estado><comprobante><![CDATA[<?xml version="1.0" encoding="UTF-8"?>\n${xml}]]></comprobante></autorizacion>`;
    expect(parseInvoiceXml(authorized).accessKey).toBe(sampleInvoice().accessKey);
  });
});
