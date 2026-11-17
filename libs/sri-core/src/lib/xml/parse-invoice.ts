import { XMLParser } from 'fast-xml-parser';
import type { ComputedLine, TaxGroup } from '../calc';
import type { CreditNoteDocument } from './credit-note';
import type { WithholdingDocument } from './withholding';
import type { InvoiceDocument } from './invoice';

/**
 * Lee una factura XML (firmada o autorizada) y la convierte al modelo InvoiceDocument.
 * El RIDE se genera desde aquí para que el PDF coincida exactamente con lo que firmó/autorizó el SRI.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  removeNSPrefix: true,
  isArray: (name) => ['detalle', 'impuesto', 'totalImpuesto', 'pago', 'campoAdicional', 'detAdicional', 'docSustento', 'impuestoDocSustento', 'retencion'].includes(name),
});

type R = Record<string, unknown>;
const s = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'object' ? String((v as R)['#text'] ?? '') : String(v));
const n = (v: unknown): string | null => (s(v) === '' ? null : s(v));
const arr = (v: unknown): R[] => (Array.isArray(v) ? (v as R[]) : v ? [v as R] : []);

/** Acepta el XML del comprobante o el documento <autorizacion> con el comprobante en CDATA. */
export function extractComprobante(xml: string): string {
  const m = /<comprobante>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/comprobante>/.exec(xml);
  return m ? m[1] : xml;
}

export function parseInvoiceXml(xmlInput: string): InvoiceDocument {
  const doc = parser.parse(extractComprobante(xmlInput)) as R;
  const f = doc['factura'] as R | undefined;
  if (!f) throw new Error('El XML no es una factura');
  const it = f['infoTributaria'] as R;
  const inf = f['infoFactura'] as R;
  const [d, m, y] = s(inf['fechaEmision']).split('/').map(Number);

  const lines: ComputedLine[] = arr((f['detalles'] as R)?.['detalle']).map((l) => {
    const subtotal = s(l['precioTotalSinImpuesto']);
    return {
      mainCode: n(l['codigoPrincipal']),
      auxCode: n(l['codigoAuxiliar']),
      description: s(l['descripcion']),
      unit: n(l['unidadMedida']),
      quantity: s(l['cantidad']),
      unitPrice: s(l['precioUnitario']),
      discount: s(l['descuento']),
      subtotal,
      taxes: arr((l['impuestos'] as R)?.['impuesto']).map((x) => ({
        taxCode: s(x['codigo']),
        percentageCode: s(x['codigoPorcentaje']),
        rate: s(x['tarifa']),
        base: s(x['baseImponible']),
        amount: s(x['valor']),
      })),
      additional: arr((l['detallesAdicionales'] as R)?.['detAdicional']).map((a) => ({ name: s(a['@nombre']), value: s(a['@valor']) })),
    };
  });

  const taxGroups: TaxGroup[] = arr((inf['totalConImpuestos'] as R)?.['totalImpuesto']).map((g) => ({
    taxCode: s(g['codigo']),
    percentageCode: s(g['codigoPorcentaje']),
    rate: s(g['tarifa']),
    base: s(g['baseImponible']),
    amount: s(g['valor']),
  }));
  const totalTax = taxGroups.reduce((acc, g) => acc + Math.round(Number(g.amount) * 100), 0);

  return {
    version: s(f['@version']),
    environment: s(it['ambiente']) === '2' ? 2 : 1,
    accessKey: s(it['claveAcceso']),
    establishment: s(it['estab']),
    emissionPoint: s(it['ptoEmi']),
    sequential: s(it['secuencial']),
    issueDate: { day: d, month: m, year: y },
    issuer: {
      ruc: s(it['ruc']),
      legalName: s(it['razonSocial']),
      tradeName: n(it['nombreComercial']),
      mainAddress: s(it['dirMatriz']),
      establishmentAddress: n(inf['dirEstablecimiento']),
      specialTaxpayerNumber: n(inf['contribuyenteEspecial']),
      keepsAccounting: s(inf['obligadoContabilidad']) === 'SI',
      withholdingAgentNumber: n(it['agenteRetencion']),
      rimpeLegend: n(it['contribuyenteRimpe']),
    },
    buyer: {
      idType: s(inf['tipoIdentificacionComprador']),
      id: s(inf['identificacionComprador']),
      name: s(inf['razonSocialComprador']),
      address: n(inf['direccionComprador']),
    },
    lines,
    totals: {
      subtotal: s(inf['totalSinImpuestos']),
      totalDiscount: s(inf['totalDescuento']),
      taxGroups,
      totalTax: (totalTax / 100).toFixed(2),
      tip: n(inf['propina']) ?? '0.00',
      total: s(inf['importeTotal']),
    },
    payments: arr((inf['pagos'] as R)?.['pago']).map((p) => ({
      code: s(p['formaPago']),
      amount: s(p['total']),
      term: n(p['plazo']),
      timeUnit: n(p['unidadTiempo']),
    })),
    additionalInfo: arr((f['infoAdicional'] as R)?.['campoAdicional']).map((c) => ({ name: s(c['@nombre']), value: s(c) })),
    currency: s(inf['moneda']) || 'DOLAR',
  };
}

/** Lee una nota de crédito XML (firmada o autorizada). Reutiliza el lector de la factura para las partes comunes. */
export function parseCreditNoteXml(xmlInput: string): CreditNoteDocument {
  const raw = extractComprobante(xmlInput);
  const doc = parser.parse(raw) as R;
  const nc = doc['notaCredito'] as R | undefined;
  if (!nc) throw new Error('El XML no es una nota de crédito');
  const inf = nc['infoNotaCredito'] as R;
  // Las partes comunes (emisor, detalle, impuestos) tienen la misma forma que en la factura.
  const asInvoice = parseInvoiceXml(
    raw.replace(/<notaCredito\b/, '<factura').replace(/<\/notaCredito>/, '</factura>').replace(/<infoNotaCredito>/, '<infoFactura>').replace(/<\/infoNotaCredito>/, '</infoFactura>').replace(/<codigoInterno>/g, '<codigoPrincipal>').replace(/<\/codigoInterno>/g, '</codigoPrincipal>').replace(/<codigoAdicional>/g, '<codigoAuxiliar>').replace(/<\/codigoAdicional>/g, '</codigoAuxiliar>'),
  );
  const [d, m, y] = s(inf['fechaEmisionDocSustento']).split('/').map(Number);
  return {
    version: asInvoice.version,
    environment: asInvoice.environment,
    accessKey: asInvoice.accessKey,
    establishment: asInvoice.establishment,
    emissionPoint: asInvoice.emissionPoint,
    sequential: asInvoice.sequential,
    issueDate: asInvoice.issueDate,
    issuer: asInvoice.issuer,
    buyer: asInvoice.buyer,
    modified: { docType: s(inf['codDocModificado']), number: s(inf['numDocModificado']), issueDate: { day: d, month: m, year: y } },
    reason: s(inf['motivo']),
    lines: asInvoice.lines,
    totals: { ...asInvoice.totals, total: s(inf['valorModificacion']), totalDiscount: '0.00' },
    additionalInfo: asInvoice.additionalInfo,
    currency: asInvoice.currency,
  };
}

/** Lee un comprobante de retención v2.0.0 (firmado o autorizado). */
export function parseWithholdingXml(xmlInput: string): WithholdingDocument {
  const doc = parser.parse(extractComprobante(xmlInput)) as R;
  const r = doc['comprobanteRetencion'] as R | undefined;
  if (!r) throw new Error('El XML no es un comprobante de retención');
  const it = r['infoTributaria'] as R;
  const inf = r['infoCompRetencion'] as R;
  const date = (v: unknown) => {
    const [d, m, y] = s(v).split('/').map(Number);
    return { day: d, month: m, year: y };
  };
  const sus = arr((r['docsSustento'] as R)?.['docSustento'])[0] ?? {};
  const num = s(sus['numDocSustento']);
  const [pm, py] = s(inf['periodoFiscal']).split('/').map(Number);
  return {
    version: s(r['@version']),
    environment: s(it['ambiente']) === '2' ? 2 : 1,
    accessKey: s(it['claveAcceso']),
    establishment: s(it['estab']),
    emissionPoint: s(it['ptoEmi']),
    sequential: s(it['secuencial']),
    issueDate: date(inf['fechaEmision']),
    issuer: {
      ruc: s(it['ruc']),
      legalName: s(it['razonSocial']),
      tradeName: n(it['nombreComercial']),
      mainAddress: s(it['dirMatriz']),
      establishmentAddress: n(inf['dirEstablecimiento']),
      specialTaxpayerNumber: n(inf['contribuyenteEspecial']),
      keepsAccounting: s(inf['obligadoContabilidad']) === 'SI',
      withholdingAgentNumber: n(it['agenteRetencion']),
      rimpeLegend: n(it['contribuyenteRimpe']),
    },
    subject: {
      idType: s(inf['tipoIdentificacionSujetoRetenido']),
      id: s(inf['identificacionSujetoRetenido']),
      name: s(inf['razonSocialSujetoRetenido']),
      relatedParty: s(inf['parteRel']) === 'SI',
    },
    fiscalPeriod: { month: pm, year: py },
    support: {
      sustentoCode: s(sus['codSustento']),
      docType: s(sus['codDocSustento']),
      number: num.length === 15 ? `${num.slice(0, 3)}-${num.slice(3, 6)}-${num.slice(6)}` : num,
      issueDate: date(sus['fechaEmisionDocSustento']),
      authorization: n(sus['numAutDocSustento']),
      subtotal: s(sus['totalSinImpuestos']),
      total: s(sus['importeTotal']),
      taxes: arr((sus['impuestosDocSustento'] as R)?.['impuestoDocSustento']).map((t) => ({
        taxCode: s(t['codImpuestoDocSustento']),
        percentageCode: s(t['codigoPorcentaje']),
        base: s(t['baseImponible']),
        rate: s(t['tarifa']),
        amount: s(t['valorImpuesto']),
      })),
      payments: arr((sus['pagos'] as R)?.['pago']).map((p) => ({ code: s(p['formaPago']), amount: s(p['total']) })),
    },
    items: arr((sus['retenciones'] as R)?.['retencion']).map((x) => ({
      tax: s(x['codigo']) as '1' | '2' | '6',
      code: s(x['codigoRetencion']),
      base: s(x['baseImponible']),
      percentage: s(x['porcentajeRetener']),
      amount: s(x['valorRetenido']),
    })),
    additionalInfo: arr((r['infoAdicional'] as R)?.['campoAdicional']).map((c) => ({ name: s(c['@nombre']), value: s(c) })),
  };
}
