import type { ReportResult } from '@vektra/shared-contracts';
import ExcelJS from 'exceljs';

const FORMATS: Record<string, string> = { money: '#,##0.00', number: '#,##0.####', percent: '0.00"%"' };

/** Libro de Excel de un reporte: título, rango, tabla con totales y notas. */
export async function reportWorkbook(r: ReportResult, company: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Vektra POS';
  const ws = wb.addWorksheet(r.title.slice(0, 31));
  ws.addRow([company]).font = { bold: true, size: 12 };
  ws.addRow([r.title]).font = { bold: true, size: 14 };
  ws.addRow([r.subtitle]).font = { italic: true, color: { argb: 'FF555555' } };
  ws.addRow([]);
  const header = ws.addRow(r.columns.map((c) => c.label));
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B5560' } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  const value = (type: string, v: unknown) => {
    if (v === null || v === undefined || v === '') return null;
    if (type === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T00:00:00Z`);
    return v as ExcelJS.CellValue;
  };
  for (const row of r.rows) ws.addRow(r.columns.map((c) => value(c.type, row[c.key])));
  if (r.totals) {
    const t = ws.addRow(r.columns.map((c) => value(c.type, r.totals?.[c.key])));
    t.font = { bold: true };
    t.eachCell((cell) => (cell.border = { top: { style: 'thin' } }));
  }
  r.columns.forEach((c, i) => {
    const column = ws.getColumn(i + 1);
    if (FORMATS[c.type]) column.numFmt = FORMATS[c.type];
    if (c.type === 'date') column.numFmt = 'dd/mm/yyyy';
    const longest = Math.max(c.label.length, ...r.rows.slice(0, 500).map((row) => String(row[c.key] ?? '').length));
    column.width = Math.min(Math.max(longest + 2, 10), 60);
  });
  ws.views = [{ state: 'frozen', ySplit: 5 }];
  if (r.notes.length) {
    ws.addRow([]);
    for (const note of r.notes) ws.addRow([note]).font = { italic: true, color: { argb: 'FF555555' } };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
