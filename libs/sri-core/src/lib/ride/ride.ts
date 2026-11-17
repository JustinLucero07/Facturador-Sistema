// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- tipos de bwip-js solo vía "exports" (ver types/bwip-js.d.ts)
/// <reference path="../../types/bwip-js.d.ts" />
import bwipjs from 'bwip-js';
import PDFDocument from 'pdfkit';
import type { CreditNoteDocument } from '../xml/credit-note';
import type { InvoiceDocument } from '../xml/invoice';
import type { WithholdingDocument } from '../xml/withholding';
import { formatIssueDate } from '../xml/invoice';

/**
 * RIDE (Representación Impresa de Documento Electrónico) de factura — Ficha Técnica v2.34, Anexo 2.
 * PDF generado en JavaScript puro (PDFKit): funciona igual en servidor y en la caja sin internet.
 * Notas del Anexo 2 aplicadas: la clave de acceso es el número de autorización; el código de barras es
 * opcional (se incluye, Code 128); se muestran solo los subtotales con valor.
 */

export interface RideOptions {
  /** Fecha/hora de autorización devuelta por el SRI (opcional en el RIDE del emisor). */
  authorizationDate?: string | null;
  /** Etiquetas por código de porcentaje de IVA (desde la BD), ej. { '4': '15%', '6': 'NO OBJETO DE IVA' } */
  rateLabels: Record<string, string>;
  /** Nombres de formas de pago (Tabla 24) por código */
  paymentLabels: Record<string, string>;
  logo?: Buffer | null;
  /** Color de marca para títulos (hex) */
  brandColor?: string;
  /** RIDE de nota de crédito: comprobante modificado y motivo (sin formas de pago) */
  creditNote?: { modifiedLabel: string; modifiedNumber: string; modifiedDate: string; reason: string } | null;
}

const MARGIN = 28;
const PAGE_W = 595.28; // A4
const CONTENT_W = PAGE_W - MARGIN * 2;
const fmt = (v: string) => Number(v).toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFmt = (v: string) => Number(v).toLocaleString('es-EC', { minimumFractionDigits: 0, maximumFractionDigits: 6 });

export async function renderInvoiceRide(doc: InvoiceDocument, opts: RideOptions): Promise<Buffer> {
  const barcode = await bwipjs.toBuffer({ bcid: 'code128', text: doc.accessKey, scale: 2, height: 9, includetext: false });

  const title = opts.creditNote ? 'NOTA DE CRÉDITO' : 'FACTURA';
  const pdf = new PDFDocument({ size: 'A4', margin: MARGIN, info: { Title: `${opts.creditNote ? 'Nota de crédito' : 'Factura'} ${serie(doc)}`, Author: doc.issuer.legalName, Creator: 'Vektra POS' } });
  const chunks: Buffer[] = [];
  pdf.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => pdf.on('end', () => resolve(Buffer.concat(chunks))));

  let y = drawHeader(pdf, doc, title, barcode, opts);

  // ─── Comprador ───
  const b = doc.buyer;
  const buyerTop = y;
  pdf.font('Helvetica-Bold').fontSize(8).text('Razón Social / Nombres y Apellidos:', MARGIN + 6, y + 6, { continued: true }).font('Helvetica').text(` ${b.name}`);
  y = pdf.y + 3;
  pdf.font('Helvetica-Bold').text('Identificación:', MARGIN + 6, y, { continued: true }).font('Helvetica').text(` ${b.id}`);
  pdf.font('Helvetica-Bold').text('Fecha Emisión:', MARGIN + CONTENT_W / 2, y, { continued: true }).font('Helvetica').text(` ${formatIssueDate(doc.issueDate)}`);
  y = pdf.y + 3;
  if (b.address) {
    pdf.font('Helvetica-Bold').text('Dirección:', MARGIN + 6, y, { continued: true }).font('Helvetica').text(` ${b.address}`, { width: CONTENT_W - 12 });
    y = pdf.y + 3;
  }
  if (opts.creditNote) {
    const cn = opts.creditNote;
    y += 2;
    pdf.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_W, y).stroke('#bbb');
    y += 5;
    pdf.font('Helvetica-Bold').fontSize(8).text('Comprobante que se modifica:', MARGIN + 6, y, { continued: true }).font('Helvetica').text(` ${cn.modifiedLabel} ${cn.modifiedNumber}`);
    pdf.font('Helvetica-Bold').text('Fecha Emisión (Comprobante a modificar):', MARGIN + CONTENT_W / 2, y, { continued: true }).font('Helvetica').text(` ${cn.modifiedDate}`);
    y = pdf.y + 3;
    pdf.font('Helvetica-Bold').text('Razón de Modificación:', MARGIN + 6, y, { continued: true }).font('Helvetica').text(` ${cn.reason}`, { width: CONTENT_W - 12 });
    y = pdf.y + 3;
  }
  pdf.rect(MARGIN, buyerTop, CONTENT_W, y - buyerTop + 3).stroke('#555');
  y += 12;

  // ─── Detalle ───
  const hasAux = doc.lines.some((l) => l.auxCode);
  const hasAdditional = doc.lines.some((l) => l.additional.length);
  const cols: { title: string; w: number; align: 'left' | 'right' | 'center'; get: (l: InvoiceDocument['lines'][number]) => string }[] = [
    { title: 'Cod. Principal', w: 58, align: 'left', get: (l) => l.mainCode ?? '' },
    ...(hasAux ? [{ title: 'Cod. Auxiliar', w: 50, align: 'left' as const, get: (l: InvoiceDocument['lines'][number]) => l.auxCode ?? '' }] : []),
    { title: 'Cantidad', w: 46, align: 'right', get: (l) => qtyFmt(l.quantity) },
    { title: 'Descripción', w: 0, align: 'left', get: (l) => l.description },
    ...(hasAdditional
      ? [{ title: 'Detalle Adicional', w: 80, align: 'left' as const, get: (l: InvoiceDocument['lines'][number]) => l.additional.map((a) => `${a.name}: ${a.value}`).join('; ') }]
      : []),
    { title: 'Precio Unitario', w: 56, align: 'right', get: (l) => Number(l.unitPrice).toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 6 }) },
    { title: 'Descuento', w: 46, align: 'right', get: (l) => fmt(l.discount) },
    { title: 'Precio Total', w: 56, align: 'right', get: (l) => fmt(l.subtotal) },
  ];
  const fixed = cols.reduce((s, c) => s + c.w, 0);
  for (const c of cols) if (c.w === 0) c.w = CONTENT_W - fixed;

  const drawRow = (cells: string[], bold: boolean, fill?: string) => {
    pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5);
    const heights = cols.map((c, k) => pdf.heightOfString(cells[k], { width: c.w - 6 }));
    const h = Math.max(...heights) + 6;
    if (y + h > pdf.page.height - MARGIN - 20) {
      pdf.addPage();
      y = MARGIN;
    }
    let x = MARGIN;
    if (fill) pdf.rect(MARGIN, y, CONTENT_W, h).fill(fill).fillColor('black');
    cols.forEach((c, k) => {
      pdf.rect(x, y, c.w, h).stroke('#999');
      pdf.fillColor('black').text(cells[k], x + 3, y + 3, { width: c.w - 6, align: c.align });
      x += c.w;
    });
    y += h;
  };
  drawRow(cols.map((c) => c.title), true, '#eef3f3');
  for (const l of doc.lines) drawRow(cols.map((c) => c.get(l)), false);
  y += 10;

  // ─── Información adicional + formas de pago (izquierda) y totales (derecha) ───
  const totW = 200;
  const totX = MARGIN + CONTENT_W - totW;
  const infoW = CONTENT_W - totW - 12;
  if (y > pdf.page.height - 230) {
    pdf.addPage();
    y = MARGIN;
  }
  const blockTop = y;

  let ly = y;
  if (doc.additionalInfo.length) {
    pdf.font('Helvetica-Bold').fontSize(8).text('Información Adicional', MARGIN, ly, { width: infoW, align: 'center' });
    ly = pdf.y + 3;
    const infoTop = ly;
    for (const a of doc.additionalInfo) {
      pdf.font('Helvetica-Bold').fontSize(7.5).text(`${a.name}:`, MARGIN + 5, ly, { width: 90 });
      pdf.font('Helvetica').text(a.value, MARGIN + 98, ly, { width: infoW - 103 });
      ly = pdf.y + 3;
    }
    pdf.rect(MARGIN, infoTop - 2, infoW, ly - infoTop + 2).stroke('#999');
    ly += 10;
  }
  if (!opts.creditNote) {
    pdf.font('Helvetica-Bold').fontSize(8).text('Forma de pago', MARGIN + 5, ly, { width: infoW * 0.7 }).text('Valor', MARGIN + infoW * 0.7, ly, { width: infoW * 0.3 - 5, align: 'right' });
    ly = pdf.y + 3;
    const payTop = ly;
    for (const p of doc.payments) {
      pdf.font('Helvetica').fontSize(7.5).text(`${p.code} - ${opts.paymentLabels[p.code] ?? ''}`, MARGIN + 5, ly, { width: infoW * 0.7 - 10 });
      const rowH = pdf.y - ly;
      pdf.text(fmt(p.amount), MARGIN + infoW * 0.7, ly, { width: infoW * 0.3 - 5, align: 'right' });
      ly += Math.max(rowH, 10) + 3;
    }
    pdf.rect(MARGIN, payTop - 2, infoW, ly - payTop + 2).stroke('#999');
  }

  // Totales
  const t = doc.totals;
  const rows: [string, string][] = [];
  for (const g of t.taxGroups.filter((g) => g.taxCode === '2')) {
    rows.push([`SUBTOTAL ${opts.rateLabels[g.percentageCode] ?? `${Number(g.rate)}%`}`, g.base]);
  }
  rows.push(['SUBTOTAL SIN IMPUESTOS', t.subtotal]);
  rows.push(['TOTAL DESCUENTO', t.totalDiscount]);
  for (const g of t.taxGroups.filter((g) => g.taxCode === '3')) rows.push(['ICE', g.amount]);
  for (const g of t.taxGroups.filter((g) => g.taxCode === '2' && Number(g.amount) > 0)) {
    rows.push([`IVA ${opts.rateLabels[g.percentageCode] ?? `${Number(g.rate)}%`}`, g.amount]);
  }
  for (const g of t.taxGroups.filter((g) => g.taxCode === '5')) rows.push(['IRBPNR', g.amount]);
  if (Number(t.tip) > 0) rows.push(['PROPINA', t.tip]);
  rows.push(['VALOR TOTAL', t.total]);

  let ty = blockTop;
  rows.forEach(([label, value], k) => {
    const last = k === rows.length - 1;
    const h = 14;
    if (last) pdf.rect(totX, ty, totW, h).fill('#eef3f3').fillColor('black');
    pdf.rect(totX, ty, totW - 70, h).stroke('#999');
    pdf.rect(totX + totW - 70, ty, 70, h).stroke('#999');
    pdf.font(last ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5).text(label, totX + 4, ty + 4, { width: totW - 78 });
    pdf.text(fmt(value), totX + totW - 68, ty + 4, { width: 64, align: 'right' });
    ty += h;
  });

  // Pie
  pdf.font('Helvetica').fontSize(6.5).fillColor('#666')
    .text('Documento generado con Vektra POS · Verifique su validez en www.sri.gob.ec', MARGIN, pdf.page.height - MARGIN - 8, { width: CONTENT_W, align: 'center' });

  pdf.end();
  return done;
}

function serie(doc: Pick<InvoiceDocument, 'establishment' | 'emissionPoint' | 'sequential'>): string {
  return `${doc.establishment}-${doc.emissionPoint}-${doc.sequential.padStart(9, '0')}`;
}

function formatAuthDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('es-EC', { timeZone: 'America/Guayaquil', dateStyle: 'short', timeStyle: 'medium' });
}

/** RIDE de nota de crédito (misma plantilla, Anexo 2): comprobante modificado y motivo. */
export function renderCreditNoteRide(doc: CreditNoteDocument, opts: Omit<RideOptions, 'creditNote'>): Promise<Buffer> {
  const totalDiscount = doc.lines.reduce((a, l) => a + Math.round(Number(l.discount) * 100), 0);
  const asInvoice: InvoiceDocument = { ...doc, payments: [], totals: { ...doc.totals, totalDiscount: (totalDiscount / 100).toFixed(2) } };
  return renderInvoiceRide(asInvoice, {
    ...opts,
    creditNote: {
      modifiedLabel: doc.modified.docType === '01' ? 'FACTURA' : `DOC. ${doc.modified.docType}`,
      modifiedNumber: doc.modified.number,
      modifiedDate: formatIssueDate(doc.modified.issueDate),
      reason: doc.reason,
    },
  });
}

interface HeaderDoc {
  issuer: InvoiceDocument['issuer'];
  environment: number;
  accessKey: string;
  establishment: string;
  emissionPoint: string;
  sequential: string;
}

/** Encabezado del RIDE (Anexo 2): emisor a la izquierda y datos de autorización a la derecha. */
function drawHeader(pdf: PDFKit.PDFDocument, doc: HeaderDoc, title: string, barcode: Buffer, opts: Pick<RideOptions, 'logo' | 'brandColor' | 'authorizationDate'>): number {
  const brand = opts.brandColor ?? '#0b5560';
  const i = doc.issuer;

  // ─── Encabezado: emisor (izquierda) y datos del comprobante (derecha) ───
  const leftW = CONTENT_W * 0.48;
  const rightX = MARGIN + leftW + 10;
  const rightW = CONTENT_W - leftW - 10;
  const y = MARGIN;

  if (opts.logo) {
    try {
      pdf.image(opts.logo, MARGIN, y, { fit: [leftW, 70], align: 'center' });
    } catch {
      /* logo inválido: se omite */
    }
  }
  const issuerTop = y + (opts.logo ? 78 : 0);
  const issuerLines: [string, string | null][] = [
    ['', i.legalName],
    ['', i.tradeName && i.tradeName !== i.legalName ? i.tradeName : null],
    ['Dirección Matriz:', i.mainAddress],
    ['Dirección Sucursal:', i.establishmentAddress ?? null],
    ['Contribuyente Especial Nro:', i.specialTaxpayerNumber ?? null],
    ['OBLIGADO A LLEVAR CONTABILIDAD:', i.keepsAccounting ? 'SI' : 'NO'],
    ['Agente de Retención Resolución No.:', i.withholdingAgentNumber ? String(Number(i.withholdingAgentNumber)) : null],
    ['', i.rimpeLegend ?? null],
  ];
  pdf.font('Helvetica');
  let iy = issuerTop + 8;
  for (const [label, value] of issuerLines) {
    if (!value) continue;
    if (!label) {
      pdf.font('Helvetica-Bold').fontSize(label === '' && value === i.legalName ? 10 : 8.5).text(value, MARGIN + 8, iy, { width: leftW - 16 });
    } else {
      pdf.font('Helvetica-Bold').fontSize(7.5).text(label, MARGIN + 8, iy, { width: leftW - 16, continued: true }).font('Helvetica').text(` ${value}`);
    }
    iy = pdf.y + 4;
  }
  const leftBottom = iy + 4;

  // Caja derecha
  let ry = y + 8;
  const rx = rightX + 8;
  const rw = rightW - 16;
  pdf.font('Helvetica-Bold').fontSize(10).text(`R.U.C.: ${i.ruc}`, rx, ry, { width: rw });
  ry = pdf.y + 4;
  pdf.fillColor(brand).fontSize(13).text(title, rx, ry, { width: rw }).fillColor('black');
  ry = pdf.y + 2;
  pdf.font('Helvetica').fontSize(9).text(`No. ${serie(doc)}`, rx, ry, { width: rw });
  ry = pdf.y + 6;
  pdf.font('Helvetica-Bold').fontSize(7.5).text('NÚMERO DE AUTORIZACIÓN', rx, ry, { width: rw });
  pdf.font('Helvetica').fontSize(7.5).text(doc.accessKey, rx, pdf.y + 2, { width: rw });
  ry = pdf.y + 6;
  const kv = (k: string, v: string) => {
    pdf.font('Helvetica-Bold').fontSize(7.5);
    const hk = pdf.heightOfString(k, { width: rw * 0.45 - 4 });
    pdf.text(k, rx, ry, { width: rw * 0.45 - 4 });
    pdf.font('Helvetica');
    const hv = pdf.heightOfString(v, { width: rw * 0.55 });
    pdf.text(v, rx + rw * 0.45, ry, { width: rw * 0.55 });
    ry += Math.max(hk, hv) + 4;
  };
  if (opts.authorizationDate) kv('FECHA Y HORA DE AUTORIZACIÓN:', formatAuthDate(opts.authorizationDate));
  kv('AMBIENTE:', doc.environment === 2 ? 'PRODUCCIÓN' : 'PRUEBAS');
  kv('EMISIÓN:', 'NORMAL');
  pdf.font('Helvetica-Bold').fontSize(7.5).text('CLAVE DE ACCESO', rx, ry, { width: rw });
  ry = pdf.y + 3;
  pdf.image(barcode, rx, ry, { width: rw, height: 34 });
  ry += 38;
  pdf.font('Helvetica').fontSize(7).text(doc.accessKey, rx, ry, { width: rw, align: 'center' });
  const rightBottom = pdf.y + 8;

  const headerBottom = Math.max(leftBottom, rightBottom);
  pdf.roundedRect(MARGIN, issuerTop, leftW, headerBottom - issuerTop, 4).stroke('#555');
  pdf.roundedRect(rightX, y, rightW, headerBottom - y, 4).stroke('#555');
  return headerBottom + 10;
}

const DOC_LABELS: Record<string, string> = { '01': 'FACTURA', '02': 'NOTA DE VENTA', '03': 'LIQUIDACIÓN DE COMPRA' };
const TAX_NAMES: Record<string, string> = { '1': 'RENTA', '2': 'IVA', '6': 'ISD' };

/** RIDE del comprobante de retención (Ficha: formato publicado para la versión 1.0.0, Anexo 2). */
export async function renderWithholdingRide(doc: WithholdingDocument, opts: Omit<RideOptions, 'creditNote' | 'rateLabels' | 'paymentLabels'>): Promise<Buffer> {
  const barcode = await bwipjs.toBuffer({ bcid: 'code128', text: doc.accessKey, scale: 2, height: 9, includetext: false });
  const pdf = new PDFDocument({ size: 'A4', margin: MARGIN, info: { Title: `Comprobante de retención ${serie(doc)}`, Author: doc.issuer.legalName, Creator: 'Vektra POS' } });
  const chunks: Buffer[] = [];
  pdf.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => pdf.on('end', () => resolve(Buffer.concat(chunks))));
  let y = drawHeader(pdf, doc, 'COMPROBANTE DE RETENCIÓN', barcode, opts);

  // Sujeto retenido
  const top = y;
  pdf.font('Helvetica-Bold').fontSize(8).text('Razón Social / Nombres y Apellidos:', MARGIN + 6, y + 6, { continued: true }).font('Helvetica').text(` ${doc.subject.name}`);
  y = pdf.y + 3;
  pdf.font('Helvetica-Bold').text('Identificación:', MARGIN + 6, y, { continued: true }).font('Helvetica').text(` ${doc.subject.id}`);
  pdf.font('Helvetica-Bold').text('Fecha Emisión:', MARGIN + CONTENT_W / 2, y, { continued: true }).font('Helvetica').text(` ${formatIssueDate(doc.issueDate)}`);
  y = pdf.y + 3;
  pdf.rect(MARGIN, top, CONTENT_W, y - top + 3).stroke('#555');
  y += 12;

  // Retenciones
  const s = doc.support;
  const cols: { title: string; w: number; align: 'left' | 'right' }[] = [
    { title: 'Comprobante', w: 70, align: 'left' },
    { title: 'Número', w: 92, align: 'left' },
    { title: 'Fecha Emisión', w: 60, align: 'left' },
    { title: 'Ejercicio Fiscal', w: 52, align: 'left' },
    { title: 'Base Imponible para la Retención', w: 80, align: 'right' },
    { title: 'Impuesto', w: 0, align: 'left' },
    { title: 'Porcentaje Retención', w: 60, align: 'right' },
    { title: 'Valor Retenido', w: 62, align: 'right' },
  ];
  const fixed = cols.reduce((a, c) => a + c.w, 0);
  for (const c of cols) if (c.w === 0) c.w = CONTENT_W - fixed;
  const period = `${String(doc.fiscalPeriod.month).padStart(2, '0')}/${doc.fiscalPeriod.year}`;
  const row = (cells: string[], bold: boolean, fill?: string) => {
    pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5);
    const h = Math.max(...cols.map((c, k) => pdf.heightOfString(cells[k], { width: c.w - 6 }))) + 6;
    let x = MARGIN;
    if (fill) pdf.rect(MARGIN, y, CONTENT_W, h).fill(fill).fillColor('black');
    cols.forEach((c, k) => {
      pdf.rect(x, y, c.w, h).stroke('#999');
      pdf.fillColor('black').text(cells[k], x + 3, y + 3, { width: c.w - 6, align: c.align });
      x += c.w;
    });
    y += h;
  };
  row(cols.map((c) => c.title), true, '#eef3f3');
  for (const it of doc.items) {
    row([DOC_LABELS[s.docType] ?? s.docType, s.number, formatIssueDate(s.issueDate), period, fmt(it.base), `${TAX_NAMES[it.tax] ?? it.tax} (${it.code})`, `${Number(it.percentage)}%`, fmt(it.amount)], false);
  }
  const total = doc.items.reduce((a, i) => a + Math.round(Number(i.amount) * 100), 0);
  pdf.font('Helvetica-Bold').fontSize(8.5).text(`TOTAL RETENIDO: ${fmt((total / 100).toFixed(2))}`, MARGIN, y + 8, { width: CONTENT_W, align: 'right' });
  y = pdf.y + 12;

  if (doc.additionalInfo.length) {
    pdf.font('Helvetica-Bold').fontSize(8).text('Información Adicional', MARGIN, y);
    y = pdf.y + 3;
    for (const a of doc.additionalInfo) {
      pdf.font('Helvetica-Bold').fontSize(7.5).text(`${a.name}:`, MARGIN + 5, y, { continued: true }).font('Helvetica').text(` ${a.value}`);
      y = pdf.y + 2;
    }
  }
  pdf.font('Helvetica').fontSize(6.5).fillColor('#666').text('Documento generado con Vektra POS · Verifique su validez en www.sri.gob.ec', MARGIN, pdf.page.height - MARGIN - 8, { width: CONTENT_W, align: 'center' });
  pdf.end();
  return done;
}
