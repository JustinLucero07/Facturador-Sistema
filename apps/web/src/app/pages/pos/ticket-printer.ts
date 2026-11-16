import type { CashSessionSummary, TicketData } from '@vektra/shared-contracts';
import { toDataURL } from 'qrcode';
import '../../core/runtime';
import { loadPrefs } from './pos.api';

/**
 * Impresión térmica desde el navegador (58 u 80 mm) con un iframe oculto y @page del ancho del rollo.
 * Funciona con cualquier impresora térmica instalada en el sistema operativo. La impresión ESC/POS
 * En la caja de escritorio (Fase 4) se imprime directo en la impresora elegida, sin diálogo.
 */
const esc = (s: string | null | undefined) =>
  (s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
const money = (v: string | number) => Number(v).toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function frameHtml(width: 58 | 80, body: string): string {
  const px = width === 58 ? 200 : 290; // ancho imprimible aproximado
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Ticket</title><style>
    @page { size: ${width}mm auto; margin: 0; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 4mm 3mm; width: ${width}mm; font: ${width === 58 ? 10 : 11.5}px/1.3 'Courier New', ui-monospace, monospace; color: #000; }
    .wrap { width: 100%; max-width: ${px}px; }
    .c { text-align: center; } .r { text-align: right; } .b { font-weight: 700; } .big { font-size: 1.35em; }
    .sm { font-size: .88em; } hr { border: 0; border-top: 1px dashed #000; margin: 4px 0; }
    table { width: 100%; border-collapse: collapse; } td { vertical-align: top; padding: 0; }
    .key { word-break: break-all; font-size: .82em; } img.logo { max-width: 60%; max-height: 60px; } img.qr { width: 110px; height: 110px; }
  </style></head><body><div class="wrap">${body}</div></body></html>`;
}

function printHtml(html: string, width: 58 | 80): Promise<void> {
  const bridge = window.vektraDesktop;
  if (bridge) return bridge.print(html, { printerName: loadPrefs().printerName, widthMm: width });
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument;
    if (!doc) return resolve();
    doc.open();
    doc.write(html);
    doc.close();
    const done = () => {
      setTimeout(() => iframe.remove(), 1000);
      resolve();
    };
    const go = () => {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
      done();
    };
    // Esperar imágenes (logo, QR) antes de imprimir
    const imgs = Array.from(doc.images);
    if (!imgs.length) setTimeout(go, 50);
    else Promise.all(imgs.map((i) => (i.complete ? Promise.resolve() : new Promise((r) => (i.onload = i.onerror = r))))).then(() => setTimeout(go, 50));
  });
}

export async function ticketHtml(t: TicketData, width: 58 | 80): Promise<string> {
  const qr = await toDataURL(t.publicRideUrl, { margin: 0, width: 220, errorCorrectionLevel: 'M' }).catch(() => null);
  const c = t.company;
  const d = new Date(t.issuedAt);
  const lines = t.lines
    .map(
      (l) => `<tr><td colspan="2">${esc(l.description)}</td></tr>
      <tr><td class="sm">${esc(l.quantity)} x ${money(l.unitPrice)}${Number(l.discount) > 0 ? ` - desc ${money(l.discount)}` : ''}</td><td class="r">${money(l.subtotal)}</td></tr>`,
    )
    .join('');
  const taxes = t.taxSummary
    .map((g) => `<tr><td>Subtotal ${esc(g.label)}</td><td class="r">${money(g.base)}</td></tr>`)
    .concat(t.taxSummary.filter((g) => Number(g.amount) > 0).map((g) => `<tr><td>IVA ${esc(g.label)}</td><td class="r">${money(g.amount)}</td></tr>`))
    .join('');
  const pays = t.payments
    .map(
      (p) =>
        `<tr><td>${esc(p.label)}</td><td class="r">${money(p.amount)}</td></tr>` +
        (p.cashReceived ? `<tr><td class="sm">Recibido</td><td class="r sm">${money(p.cashReceived)}</td></tr><tr><td class="b">Cambio</td><td class="r b">${money(p.change ?? 0)}</td></tr>` : ''),
    )
    .join('');
  const body = `
    ${c.logoBase64 ? `<div class="c"><img class="logo" src="data:image/png;base64,${c.logoBase64}" alt=""></div>` : ''}
    <div class="c b">${esc(c.tradeName ?? c.legalName)}</div>
    ${c.tradeName && c.tradeName !== c.legalName ? `<div class="c sm">${esc(c.legalName)}</div>` : ''}
    <div class="c sm">RUC ${esc(c.ruc)}</div>
    <div class="c sm">Matriz: ${esc(c.mainAddress)}</div>
    ${c.establishmentAddress && c.establishmentAddress !== c.mainAddress ? `<div class="c sm">Sucursal: ${esc(c.establishmentAddress)}</div>` : ''}
    <div class="c sm">Obligado a llevar contabilidad: ${c.keepsAccounting ? 'SI' : 'NO'}</div>
    ${c.specialTaxpayerNumber ? `<div class="c sm">Contribuyente especial: ${esc(c.specialTaxpayerNumber)}</div>` : ''}
    ${c.withholdingAgentNumber ? `<div class="c sm">Agente de retención Res. ${esc(c.withholdingAgentNumber)}</div>` : ''}
    ${c.rimpeLegend ? `<div class="c sm b">${esc(c.rimpeLegend)}</div>` : ''}
    <hr>
    <div class="c b">FACTURA ${esc(t.number)}</div>
    ${t.environment === 1 ? '<div class="c b">*** AMBIENTE DE PRUEBAS ***</div>' : ''}
    <div class="sm">Fecha: ${d.toLocaleDateString('es-EC')} ${d.toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' })}</div>
    <div class="sm">Autorización / clave de acceso:</div>
    <div class="key">${esc(t.accessKey)}</div>
    <hr>
    <div class="sm">Cliente: ${esc(t.buyer.name)}</div>
    <div class="sm">${t.buyer.idType === '04' ? 'RUC' : t.buyer.idType === '05' ? 'C.I.' : 'ID'}: ${esc(t.buyer.id)}</div>
    ${t.buyer.address ? `<div class="sm">Dir.: ${esc(t.buyer.address)}</div>` : ''}
    <hr>
    <table>${lines}</table>
    <hr>
    <table>${taxes}
      ${Number(t.totalDiscount) > 0 ? `<tr><td>Descuento</td><td class="r">${money(t.totalDiscount)}</td></tr>` : ''}
      <tr><td class="b big">TOTAL</td><td class="r b big">$${money(t.total)}</td></tr>
    </table>
    <hr>
    <table>${pays}</table>
    <hr>
    ${qr ? `<div class="c"><img class="qr" src="${qr}" alt=""><div class="sm">Escanee para descargar su factura electrónica</div></div>` : ''}
    <div class="c sm">${t.cashier ? `Atendido por: ${esc(t.cashier)}<br>` : ''}Verifique su comprobante en www.sri.gob.ec</div>
    <div class="c sm">Gracias por su compra</div>`;
  return frameHtml(width, body);
}

export async function printTicket(t: TicketData, width: 58 | 80): Promise<void> {
  await printHtml(await ticketHtml(t, width), width);
}

export function printCashReport(s: CashSessionSummary, company: string, width: 58 | 80): Promise<void> {
  const row = (a: string, b: string, cls = '') => `<tr><td class="${cls}">${esc(a)}</td><td class="r ${cls}">${esc(b)}</td></tr>`;
  const methods = s.methods
    .map(
      (m) =>
        `<tr><td colspan="2" class="b">${esc(m.label)} (${m.count})</td></tr>` +
        row('Esperado', money(m.expected)) +
        (m.counted !== null ? row('Contado', money(m.counted)) + row('Diferencia', money(m.difference ?? 0), Number(m.difference) !== 0 ? 'b' : '') : ''),
    )
    .join('');
  const body = `
    <div class="c b">${esc(company)}</div>
    <div class="c b">${s.status === 'CLOSED' ? 'CIERRE DE CAJA' : 'CORTE PARCIAL DE CAJA'}</div>
    <div class="c sm">${esc(s.emissionPoint)}</div>
    <hr>
    <table>
      ${row('Apertura', `${new Date(s.openedAt).toLocaleString('es-EC')}`)}
      ${row('Abrió', s.openedBy)}
      ${s.closedAt ? row('Cierre', new Date(s.closedAt).toLocaleString('es-EC')) + row('Cerró', s.closedBy ?? '') : ''}
    </table>
    <hr>
    <table>
      ${row('Facturas', String(s.invoices))}
      ${row('Total vendido', money(s.totalSales), 'b')}
    </table>
    <hr>
    <div class="b">EFECTIVO</div>
    <table>
      ${row('Fondo inicial', money(s.cash.opening))}
      ${row('+ Ventas', money(s.cash.sales))}
      ${row('+ Ingresos', money(s.cash.in))}
      ${row('- Egresos', money(s.cash.out))}
      ${row('= Esperado', money(s.cash.expected), 'b')}
    </table>
    <hr>
    <table>${methods}</table>
    ${s.difference !== null ? `<hr><table>${row('DIFERENCIA TOTAL', money(s.difference), 'b big')}</table>` : ''}
    <hr>
    <div class="b">Ventas por usuario</div>
    <table>${s.byUser.map((u) => row(`${u.user} (${u.invoices})`, money(u.total))).join('')}</table>
    ${s.movements.length ? `<hr><div class="b">Movimientos</div><table>${s.movements.map((m) => row(`${m.type === 'IN' ? '+' : '-'} ${m.reason}`, money(m.amount))).join('')}</table>` : ''}
    ${s.notes ? `<hr><div class="sm">Obs.: ${esc(s.notes)}</div>` : ''}
    <br><br><div class="c sm">_____________________<br>Firma cajero</div>`;
  return printHtml(frameHtml(width, body), width);
}
