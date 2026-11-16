import { XMLParser } from 'fast-xml-parser';
import type { ComputedLine, TaxGroup } from '../calc';
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
  isArray: (name) => ['detalle', 'impuesto', 'totalImpuesto', 'pago', 'campoAdicional', 'detAdicional'].includes(name),
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
