import { dec, money } from '../money';
import { AdditionalField, formatIssueDate, invoiceInfoTributaria, Issuer } from './invoice';
import { el, opt, serialize, txt, XmlElement } from './writer';

/**
 * Comprobante de retención electrónico (codDoc 07), formato ATS v2.0.0 — Ficha Técnica offline
 * v2.34, Anexo 10, y orden de elementos de ComprobanteRetencion_V2.0.0.xsd (SRI).
 * Alcance: pagos a residentes (pagoLocExt 01) sin reembolsos ni dividendos.
 * Códigos: Tabla 19 (impuesto: 1 renta, 2 IVA, 6 ISD), Tabla 20 (porcentajes de IVA) y
 * Catálogo ATS (conceptos de renta, Tabla 4 tipo de comprobante, Tabla 5 sustento).
 */
export interface WithholdingItem {
  /** Tabla 19: 1 renta, 2 IVA, 6 ISD */
  tax: '1' | '2' | '6';
  /** Renta: concepto del Catálogo ATS (312, 343…). IVA: Tabla 20 (9, 10, 1, 11, 2, 3, 7, 8). */
  code: string;
  base: string;
  /** Porcentaje (ej. 1.75) */
  percentage: string;
  amount: string;
}

export interface SupportDocTax {
  /** Tabla 16 */
  taxCode: string;
  /** Tabla 17 */
  percentageCode: string;
  base: string;
  rate: string;
  amount: string;
}

export interface WithholdingDocument {
  version: string;
  environment: 1 | 2;
  accessKey: string;
  establishment: string;
  emissionPoint: string;
  sequential: string;
  issueDate: { day: number; month: number; year: number };
  issuer: Issuer;
  subject: {
    /** Tabla 6 (04 RUC, 05 cédula, 06 pasaporte, 08 exterior; nunca 07) */
    idType: string;
    id: string;
    name: string;
    /** Tabla 14 del Catálogo ATS (01 natural, 02 sociedad); solo con identificación del exterior */
    subjectType?: '01' | '02' | null;
    relatedParty: boolean;
  };
  fiscalPeriod: { month: number; year: number };
  support: {
    /** Tabla 5 del Catálogo ATS (ej. 06 Inventario - crédito tributario IVA) */
    sustentoCode: string;
    /** Tabla 4 del Catálogo ATS (01 factura, 02 nota de venta, 03 liquidación) */
    docType: string;
    /** 001-001-000000123 */
    number: string;
    issueDate: { day: number; month: number; year: number };
    accountingDate?: { day: number; month: number; year: number } | null;
    authorization?: string | null;
    subtotal: string;
    total: string;
    taxes: SupportDocTax[];
    /** Tabla 24 de la Ficha / 13 del Catálogo ATS */
    payments: { code: string; amount: string }[];
  };
  items: WithholdingItem[];
  additionalInfo: AdditionalField[];
}

/** Valor retenido = base × porcentaje ÷ 100, redondeado a centavos. */
export function withholdingAmount(base: string, percentage: string): string {
  return money(dec(base).times(dec(percentage)).div(100));
}

/** Porcentaje sin ceros sobrantes ("1.75", "2", "30"): el XSD admite máximo 3 dígitos con 2 decimales. */
const pct = (v: string) => dec(v).toDecimalPlaces(2).toString();

export function buildWithholdingElement(doc: WithholdingDocument): XmlElement {
  if (doc.subject.idType === '07') throw new Error('El comprobante de retención debe identificar al sujeto retenido (no se admite consumidor final)');
  if (!/^\d{3}-\d{3}-\d{9}$/.test(doc.support.number)) throw new Error('Número del documento de sustento inválido (formato 001-001-000000001)');
  if (!doc.items.length) throw new Error('Agregue al menos una retención');
  if (doc.additionalInfo.length > 15) throw new Error('Máximo 15 campos de información adicional');
  const i = doc.issuer;
  const s = doc.support;
  const mm = String(doc.fiscalPeriod.month).padStart(2, '0');
  return {
    name: 'comprobanteRetencion',
    attrs: { id: 'comprobante', version: doc.version },
    children: [
      invoiceInfoTributaria(doc, '07'),
      el(
        'infoCompRetencion',
        null,
        txt('fechaEmision', formatIssueDate(doc.issueDate)),
        opt('dirEstablecimiento', i.establishmentAddress),
        opt('contribuyenteEspecial', i.specialTaxpayerNumber),
        txt('obligadoContabilidad', i.keepsAccounting ? 'SI' : 'NO'),
        txt('tipoIdentificacionSujetoRetenido', doc.subject.idType),
        doc.subject.idType === '08' ? opt('tipoSujetoRetenido', doc.subject.subjectType) : null,
        txt('parteRel', doc.subject.relatedParty ? 'SI' : 'NO'),
        txt('razonSocialSujetoRetenido', doc.subject.name),
        txt('identificacionSujetoRetenido', doc.subject.id),
        txt('periodoFiscal', `${mm}/${doc.fiscalPeriod.year}`),
      ),
      el(
        'docsSustento',
        null,
        el(
          'docSustento',
          null,
          txt('codSustento', s.sustentoCode),
          txt('codDocSustento', s.docType),
          txt('numDocSustento', s.number.replace(/-/g, '')),
          txt('fechaEmisionDocSustento', formatIssueDate(s.issueDate)),
          s.accountingDate ? txt('fechaRegistroContable', formatIssueDate(s.accountingDate)) : null,
          opt('numAutDocSustento', s.authorization),
          txt('pagoLocExt', '01'),
          txt('totalSinImpuestos', s.subtotal),
          txt('importeTotal', s.total),
          el(
            'impuestosDocSustento',
            null,
            ...s.taxes.map((t) =>
              el(
                'impuestoDocSustento',
                null,
                txt('codImpuestoDocSustento', t.taxCode),
                txt('codigoPorcentaje', t.percentageCode),
                txt('baseImponible', t.base),
                txt('tarifa', pct(t.rate)),
                txt('valorImpuesto', t.amount),
              ),
            ),
          ),
          el(
            'retenciones',
            null,
            ...doc.items.map((r) =>
              el(
                'retencion',
                null,
                txt('codigo', r.tax),
                txt('codigoRetencion', r.code),
                txt('baseImponible', r.base),
                txt('porcentajeRetener', pct(r.percentage)),
                txt('valorRetenido', r.amount),
              ),
            ),
          ),
          el('pagos', null, ...s.payments.map((p) => el('pago', null, txt('formaPago', p.code), txt('total', p.amount)))),
        ),
      ),
      doc.additionalInfo.length
        ? el('infoAdicional', null, ...doc.additionalInfo.map((a) => ({ name: 'campoAdicional', attrs: { nombre: a.name }, children: [a.value] })))
        : null,
    ],
  };
}

/** XML del comprobante de retención sin firma (forma canónica, sin declaración XML). */
export function buildWithholdingXml(doc: WithholdingDocument): string {
  return serialize(buildWithholdingElement(doc));
}
