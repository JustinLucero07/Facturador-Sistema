import type { ComputedLine, Totals } from '../calc';
import { el, opt, serialize, txt, XmlElement } from './writer';

/**
 * Factura electrónica (codDoc 01), formato XML v1.1.0 / v2.1.0 según el XSD oficial del SRI
 * (orden de elementos tomado de factura_V1.1.0.xsd). Solo los campos de una venta local estándar;
 * exportación, reembolsos, subsidios y combustibles se agregarán cuando un módulo los necesite.
 */

export interface Issuer {
  ruc: string;
  legalName: string;
  tradeName?: string | null;
  mainAddress: string;
  establishmentAddress?: string | null;
  /** Número de resolución de contribuyente especial */
  specialTaxpayerNumber?: string | null;
  keepsAccounting: boolean;
  /** Anexo 21: número de resolución de agente de retención, sin ceros a la izquierda */
  withholdingAgentNumber?: string | null;
  /** Anexo 22: leyenda RIMPE (texto exacto configurado en BD) */
  rimpeLegend?: string | null;
}

export interface Buyer {
  /** Tabla 6: 04 RUC, 05 cédula, 06 pasaporte, 07 consumidor final, 08 exterior */
  idType: string;
  id: string;
  name: string;
  address?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface Payment {
  /** Tabla 24 */
  code: string;
  amount: string;
  term?: string | null;
  timeUnit?: string | null;
}

export interface AdditionalField {
  name: string;
  value: string;
}

export interface InvoiceDocument {
  version: string;
  environment: 1 | 2;
  accessKey: string;
  establishment: string;
  emissionPoint: string;
  sequential: string;
  issueDate: { day: number; month: number; year: number };
  issuer: Issuer;
  buyer: Buyer;
  lines: ComputedLine[];
  totals: Totals;
  payments: Payment[];
  /** infoAdicional: máximo 15 campos de hasta 300 caracteres (numeral 9.11) */
  additionalInfo: AdditionalField[];
  /** Ej. "DOLAR" (configurable) */
  currency: string;
}

const dd = (n: number) => String(n).padStart(2, '0');

export function formatIssueDate(d: InvoiceDocument['issueDate']): string {
  return `${dd(d.day)}/${dd(d.month)}/${d.year}`;
}

export function invoiceInfoTributaria(
  doc: Pick<InvoiceDocument, 'issuer' | 'environment' | 'accessKey' | 'establishment' | 'emissionPoint' | 'sequential'>,
  docType = '01',
): XmlElement {
  const i = doc.issuer;
  return el(
    'infoTributaria',
    null,
    txt('ambiente', doc.environment),
    txt('tipoEmision', '1'),
    txt('razonSocial', i.legalName),
    opt('nombreComercial', i.tradeName),
    txt('ruc', i.ruc),
    txt('claveAcceso', doc.accessKey),
    txt('codDoc', docType),
    txt('estab', doc.establishment),
    txt('ptoEmi', doc.emissionPoint),
    txt('secuencial', doc.sequential.padStart(9, '0')),
    txt('dirMatriz', i.mainAddress),
    opt('agenteRetencion', i.withholdingAgentNumber ? String(Number(i.withholdingAgentNumber)) : null),
    opt('contribuyenteRimpe', i.rimpeLegend),
  );
}

export function buildInvoiceElement(doc: InvoiceDocument): XmlElement {
  if (doc.additionalInfo.length > 15) throw new Error('Máximo 15 campos de información adicional');
  const i = doc.issuer;
  const t = doc.totals;
  return {
    name: 'factura',
    attrs: { id: 'comprobante', version: doc.version },
    children: [
      invoiceInfoTributaria(doc),
      el(
        'infoFactura',
        null,
        txt('fechaEmision', formatIssueDate(doc.issueDate)),
        opt('dirEstablecimiento', i.establishmentAddress),
        opt('contribuyenteEspecial', i.specialTaxpayerNumber),
        txt('obligadoContabilidad', i.keepsAccounting ? 'SI' : 'NO'),
        txt('tipoIdentificacionComprador', doc.buyer.idType),
        txt('razonSocialComprador', doc.buyer.name),
        txt('identificacionComprador', doc.buyer.id),
        opt('direccionComprador', doc.buyer.address),
        txt('totalSinImpuestos', t.subtotal),
        txt('totalDescuento', t.totalDiscount),
        el(
          'totalConImpuestos',
          null,
          ...t.taxGroups.map((g) =>
            el('totalImpuesto', null, txt('codigo', g.taxCode), txt('codigoPorcentaje', g.percentageCode), txt('baseImponible', g.base), txt('tarifa', g.rate), txt('valor', g.amount)),
          ),
        ),
        txt('propina', t.tip),
        txt('importeTotal', t.total),
        opt('moneda', doc.currency),
        doc.payments.length
          ? el(
              'pagos',
              null,
              ...doc.payments.map((p) => el('pago', null, txt('formaPago', p.code), txt('total', p.amount), opt('plazo', p.term), opt('unidadTiempo', p.timeUnit))),
            )
          : null,
      ),
      el(
        'detalles',
        null,
        ...doc.lines.map((l) =>
          el(
            'detalle',
            null,
            opt('codigoPrincipal', l.mainCode),
            opt('codigoAuxiliar', l.auxCode),
            txt('descripcion', l.description),
            opt('unidadMedida', l.unit),
            txt('cantidad', l.quantity),
            txt('precioUnitario', l.unitPrice),
            txt('descuento', l.discount),
            txt('precioTotalSinImpuesto', l.subtotal),
            l.additional.length ? el('detallesAdicionales', null, ...l.additional.slice(0, 3).map((a) => el('detAdicional', { nombre: a.name, valor: a.value }))) : null,
            el(
              'impuestos',
              null,
              ...l.taxes.map((x) =>
                el('impuesto', null, txt('codigo', x.taxCode), txt('codigoPorcentaje', x.percentageCode), txt('tarifa', x.rate), txt('baseImponible', x.base), txt('valor', x.amount)),
              ),
            ),
          ),
        ),
      ),
      doc.additionalInfo.length
        ? el('infoAdicional', null, ...doc.additionalInfo.map((a) => ({ name: 'campoAdicional', attrs: { nombre: a.name }, children: [a.value] })))
        : null,
    ],
  };
}

/** XML de la factura sin firma (forma canónica, sin declaración XML). */
export function buildInvoiceXml(doc: InvoiceDocument): string {
  return serialize(buildInvoiceElement(doc));
}
