import { validateXML } from 'xmllint-wasm';
import { dec, money } from '../money';
import { XSD_FILES } from '../xsd/bundle.generated';
import { el, opt, serialize, txt, XmlChild, XmlElement } from '../xml/writer';

/**
 * Anexo Transaccional Simplificado (ATS) — Ficha Técnica ATS (SRI, actualizada 07/02/2025) y
 * at.xsd del programa DIMM ATS 1.19.0 (libs/sri-core/xsd/ATS_at.xsd).
 * Alcance: módulos de compras (pagos a residentes, sin reembolsos ni dividendos), ventas,
 * ventas por establecimiento y anulados. No incluye exportaciones, RECAP, fideicomisos ni
 * rendimientos financieros (no los genera el sistema).
 */

export interface AtsDate {
  day: number;
  month: number;
  year: number;
}

export interface AtsAirLine {
  /** Concepto del Catálogo ATS (Tabla 3.10) */
  code: string;
  base: string;
  percentage: string;
  amount: string;
}

export interface AtsPurchase {
  /** Tabla 5 */
  sustentoCode: string;
  /** Tabla 2 (compras): 01 RUC, 02 cédula, 03 pasaporte / identificación del exterior */
  idType: '01' | '02' | '03';
  id: string;
  /** Tabla 14 (solo con idType 03) */
  personType?: string | null;
  /** Razón social (solo se informa con idType 03) */
  name: string;
  relatedParty: boolean;
  /** Tabla 4 (01 factura, 02 nota de venta, 03 liquidación, 04 nota de crédito…) */
  docType: string;
  accountingDate: AtsDate;
  establishment: string;
  emissionPoint: string;
  sequential: string;
  issueDate: AtsDate;
  authorization: string;
  baseNoGraIva: string;
  baseImponible: string;
  baseImpGrav: string;
  baseImpExe: string;
  montoIce: string;
  montoIva: string;
  /** Valores retenidos de IVA por porcentaje (10, 20, 30, 50, 70, 100) */
  ivaWithholding: Partial<Record<'10' | '20' | '30' | '50' | '70' | '100', string>>;
  /** Tabla 13; vacío si no aplica */
  paymentForms: string[];
  air: AtsAirLine[];
  /** Comprobante de retención emitido */
  withholding?: {
    establishment: string;
    emissionPoint: string;
    sequential: string;
    authorization: string;
    issueDate: AtsDate;
  } | null;
  /** Comprobante modificado (solo notas de crédito / débito, Tabla 4 códigos 04 y 05) */
  modified?: {
    docType: string;
    establishment: string;
    emissionPoint: string;
    sequential: string;
    authorization: string;
  } | null;
}

export interface AtsSale {
  /** Tabla 2 (ventas): 04 RUC, 05 cédula, 06 pasaporte, 07 consumidor final */
  idType: '04' | '05' | '06' | '07';
  id: string;
  /** Tabla 14 (solo con idType 06) */
  personType?: string | null;
  name: string;
  relatedParty: boolean;
  /** Tabla 4: 18 documentos autorizados en ventas (excepto N/C y N/D), 04 nota de crédito, 05 nota de débito */
  docType: string;
  /** Tabla 20: E electrónica, F física */
  emission: 'E' | 'F';
  count: number;
  baseNoGraIva: string;
  baseImponible: string;
  baseImpGrav: string;
  montoIva: string;
  montoIce: string;
  ivaWithheld: string;
  rentaWithheld: string;
  paymentForms: string[];
}

export interface AtsVoided {
  docType: string;
  establishment: string;
  emissionPoint: string;
  from: string;
  to: string;
  authorization: string;
}

export interface AtsReport {
  ruc: string;
  name: string;
  year: number;
  /** 01–12; en semestral 06 o 12 */
  month: number;
  /** Régimen RIMPE que presenta semestralmente (regimenMicroempresa = SI) */
  semiannual?: boolean;
  /** Número de establecimientos activos inscritos en el RUC */
  establishmentsCount: number;
  totalSales: string;
  purchases: AtsPurchase[];
  sales: AtsSale[];
  /** Ventas por establecimiento; se informa un registro por cada establecimiento */
  salesByEstablishment: { code: string; total: string }[];
  voided: AtsVoided[];
}

const pad2 = (n: number) => String(n).padStart(2, '0');

export function atsDate(d: AtsDate): string {
  return `${pad2(d.day)}/${pad2(d.month)}/${d.year}`;
}

/**
 * Texto para los campos de razón social del ATS: el XSD solo admite letras, números y espacios
 * (patrón [a-zA-Z0-9][a-zA-Z0-9\s]*). Se quitan tildes y signos.
 */
export function atsName(value: string, max = 500): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

/** Secuencial sin ceros a la izquierda (tipo entero del XSD). */
const seq = (v: string) => String(BigInt(v));
const m2 = (v: string) => money(dec(v));
const pct = (v: string) => dec(v).toFixed(2);

function paymentForms(codes: string[]): XmlElement | null {
  const unique = [...new Set(codes)].sort();
  return unique.length ? el('formasDePago', null, ...unique.map((c) => txt('formaPago', c))) : null;
}

function purchaseElement(p: AtsPurchase): XmlElement {
  const foreign = p.idType === '03';
  const w = p.ivaWithholding;
  const children: XmlChild[] = [
    txt('codSustento', p.sustentoCode),
    txt('tpIdProv', p.idType),
    txt('idProv', p.id),
    txt('tipoComprobante', p.docType),
    foreign ? opt('tipoProv', p.personType) : null,
    foreign ? opt('denoProv', atsName(p.name)) : null,
    txt('parteRel', p.relatedParty ? 'SI' : 'NO'),
    txt('fechaRegistro', atsDate(p.accountingDate)),
    txt('establecimiento', p.establishment),
    txt('puntoEmision', p.emissionPoint),
    txt('secuencial', seq(p.sequential)),
    txt('fechaEmision', atsDate(p.issueDate)),
    txt('autorizacion', p.authorization),
    txt('baseNoGraIva', m2(p.baseNoGraIva)),
    txt('baseImponible', m2(p.baseImponible)),
    txt('baseImpGrav', m2(p.baseImpGrav)),
    txt('baseImpExe', m2(p.baseImpExe)),
    txt('montoIce', m2(p.montoIce)),
    txt('montoIva', m2(p.montoIva)),
    txt('valRetBien10', m2(w['10'] ?? '0')),
    txt('valRetServ20', m2(w['20'] ?? '0')),
    txt('valorRetBienes', m2(w['30'] ?? '0')),
    txt('valRetServ50', m2(w['50'] ?? '0')),
    txt('valorRetServicios', m2(w['70'] ?? '0')),
    txt('valRetServ100', m2(w['100'] ?? '0')),
    // Solo pagos a residentes: los campos del exterior no aplican (NA)
    el(
      'pagoExterior',
      null,
      txt('pagoLocExt', '01'),
      txt('paisEfecPago', 'NA'),
      txt('aplicConvDobTrib', 'NA'),
      txt('pagExtSujRetNorLeg', 'NA'),
    ),
    paymentForms(p.paymentForms),
    p.air.length
      ? el(
          'air',
          null,
          ...p.air.map((a) =>
            el(
              'detalleAir',
              null,
              txt('codRetAir', a.code),
              txt('baseImpAir', m2(a.base)),
              txt('porcentajeAir', pct(a.percentage)),
              txt('valRetAir', m2(a.amount)),
            ),
          ),
        )
      : null,
  ];
  if (p.withholding) {
    children.push(
      txt('estabRetencion1', p.withholding.establishment),
      txt('ptoEmiRetencion1', p.withholding.emissionPoint),
      txt('secRetencion1', seq(p.withholding.sequential)),
      txt('autRetencion1', p.withholding.authorization),
      txt('fechaEmiRet1', atsDate(p.withholding.issueDate)),
    );
  }
  if (p.modified) {
    children.push(
      txt('docModificado', p.modified.docType),
      txt('estabModificado', p.modified.establishment),
      txt('ptoEmiModificado', p.modified.emissionPoint),
      txt('secModificado', seq(p.modified.sequential)),
      txt('autModificado', p.modified.authorization),
    );
  }
  return el('detalleCompras', null, ...children);
}

function saleElement(s: AtsSale): XmlElement {
  const identified = s.idType !== '07';
  const foreign = s.idType === '06';
  return el(
    'detalleVentas',
    null,
    txt('tpIdCliente', s.idType),
    txt('idCliente', s.id),
    identified ? txt('parteRelVtas', s.relatedParty ? 'SI' : 'NO') : null,
    foreign ? opt('tipoCliente', s.personType) : null,
    foreign ? opt('denoCli', atsName(s.name)) : null,
    txt('tipoComprobante', s.docType),
    txt('tipoEmision', s.emission),
    txt('numeroComprobantes', String(s.count)),
    txt('baseNoGraIva', m2(s.baseNoGraIva)),
    txt('baseImponible', m2(s.baseImponible)),
    txt('baseImpGrav', m2(s.baseImpGrav)),
    txt('montoIva', m2(s.montoIva)),
    txt('montoIce', m2(s.montoIce)),
    txt('valorRetIva', m2(s.ivaWithheld)),
    txt('valorRetRenta', m2(s.rentaWithheld)),
    paymentForms(s.paymentForms),
  );
}

export function buildAtsElement(r: AtsReport): XmlElement {
  return el(
    'iva',
    null,
    txt('TipoIDInformante', 'R'),
    txt('IdInformante', r.ruc),
    txt('razonSocial', atsName(r.name)),
    txt('Anio', String(r.year)),
    txt('Mes', pad2(r.month)),
    r.semiannual ? txt('regimenMicroempresa', 'SI') : null,
    txt('numEstabRuc', String(r.establishmentsCount).padStart(3, '0')),
    txt('totalVentas', m2(r.totalSales)),
    txt('codigoOperativo', 'IVA'),
    r.purchases.length ? el('compras', null, ...r.purchases.map(purchaseElement)) : null,
    r.sales.length ? el('ventas', null, ...r.sales.map(saleElement)) : null,
    r.salesByEstablishment.length
      ? el(
          'ventasEstablecimiento',
          null,
          ...r.salesByEstablishment.map((e) => el('ventaEst', null, txt('codEstab', e.code), txt('ventasEstab', m2(e.total)))),
        )
      : null,
    r.voided.length
      ? el(
          'anulados',
          null,
          ...r.voided.map((v) =>
            el(
              'detalleAnulados',
              null,
              txt('tipoComprobante', v.docType),
              txt('establecimiento', v.establishment),
              txt('puntoEmision', v.emissionPoint),
              txt('secuencialInicio', seq(v.from)),
              txt('secuencialFin', seq(v.to)),
              txt('autorizacion', v.authorization),
            ),
          ),
        )
      : null,
  );
}

/** Declaración del ejemplo oficial del SRI; el contenido es ASCII (atsName), válido en ISO-8859-1. */
export const ATS_XML_DECLARATION = '<?xml version="1.0" encoding="ISO-8859-1" standalone="yes"?>';

export function buildAtsXml(r: AtsReport): string {
  return `${ATS_XML_DECLARATION}\n${serialize(buildAtsElement(r))}`;
}

/** Nombre oficial del archivo: ATmmaaaa (Ficha ATS, numeral 1.2). */
export function atsFileName(year: number, month: number): string {
  return `AT${pad2(month)}${year}`;
}

/** Valida el ATS contra el at.xsd del DIMM. */
export async function validateAts(xml: string): Promise<{ valid: boolean; errors: string[] }> {
  const result = await validateXML({
    xml: [{ fileName: 'ats.xml', contents: xml }],
    schema: [{ fileName: 'ATS_at.xsd', contents: XSD_FILES['ATS_at.xsd'] }],
  });
  return { valid: result.valid, errors: result.errors.map((e) => e.message.replace(/^ats\.xml:\d+: /, '').trim()) };
}
