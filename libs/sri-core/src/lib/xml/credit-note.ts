import type { ComputedLine, Totals } from '../calc';
import { AdditionalField, Buyer, formatIssueDate, invoiceInfoTributaria, Issuer } from './invoice';
import { el, opt, serialize, txt, XmlElement } from './writer';

/**
 * Nota de crédito electrónica (codDoc 04), formato XML v1.1.0. Orden de elementos tomado de
 * NotaCredito_V1.1.0.xsd (SRI). Ficha Técnica offline v2.34:
 *  - la tarifa de IVA es la de la fecha de emisión del documento de sustento (se copian los
 *    impuestos de la factura original);
 *  - el receptor debe identificarse (Tabla 6: no se admite consumidor final 07).
 */
export interface CreditNoteDocument {
  version: string;
  environment: 1 | 2;
  accessKey: string;
  establishment: string;
  emissionPoint: string;
  sequential: string;
  issueDate: { day: number; month: number; year: number };
  issuer: Issuer;
  buyer: Buyer;
  /** Documento modificado (Tabla 3, normalmente 01 factura) */
  modified: { docType: string; number: string; issueDate: { day: number; month: number; year: number } };
  reason: string;
  lines: ComputedLine[];
  totals: Totals;
  additionalInfo: AdditionalField[];
  currency: string;
}

export function buildCreditNoteElement(doc: CreditNoteDocument): XmlElement {
  if (doc.buyer.idType === '07') throw new Error('La nota de crédito debe identificar al cliente (no se admite consumidor final)');
  if (!/^\d{3}-\d{3}-\d{9}$/.test(doc.modified.number)) throw new Error('Número del documento modificado inválido (formato 001-001-000000001)');
  if (doc.additionalInfo.length > 15) throw new Error('Máximo 15 campos de información adicional');
  const i = doc.issuer;
  const t = doc.totals;
  return {
    name: 'notaCredito',
    attrs: { id: 'comprobante', version: doc.version },
    children: [
      invoiceInfoTributaria(doc, '04'),
      el(
        'infoNotaCredito',
        null,
        txt('fechaEmision', formatIssueDate(doc.issueDate)),
        opt('dirEstablecimiento', i.establishmentAddress),
        txt('tipoIdentificacionComprador', doc.buyer.idType),
        txt('razonSocialComprador', doc.buyer.name),
        txt('identificacionComprador', doc.buyer.id),
        opt('contribuyenteEspecial', i.specialTaxpayerNumber),
        txt('obligadoContabilidad', i.keepsAccounting ? 'SI' : 'NO'),
        txt('codDocModificado', doc.modified.docType),
        txt('numDocModificado', doc.modified.number),
        txt('fechaEmisionDocSustento', formatIssueDate(doc.modified.issueDate)),
        txt('totalSinImpuestos', t.subtotal),
        txt('valorModificacion', t.total),
        opt('moneda', doc.currency),
        el(
          'totalConImpuestos',
          null,
          ...t.taxGroups.map((g) => el('totalImpuesto', null, txt('codigo', g.taxCode), txt('codigoPorcentaje', g.percentageCode), txt('baseImponible', g.base), txt('valor', g.amount))),
        ),
        txt('motivo', doc.reason.replace(/\s*\n\s*/g, ' ').slice(0, 300)),
      ),
      el(
        'detalles',
        null,
        ...doc.lines.map((l) =>
          el(
            'detalle',
            null,
            opt('codigoInterno', l.mainCode),
            opt('codigoAdicional', l.auxCode),
            txt('descripcion', l.description),
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

/** XML de la nota de crédito sin firma (forma canónica, sin declaración XML). */
export function buildCreditNoteXml(doc: CreditNoteDocument): string {
  return serialize(buildCreditNoteElement(doc));
}
