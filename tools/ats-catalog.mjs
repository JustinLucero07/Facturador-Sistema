// Genera libs/db/src/lib/withholding-catalog.generated.ts desde el Catálogo ATS oficial del SRI
// (docs/sri/Catalogo_ATS.xls, hoja "TABLAS RETENCIONES", Tabla 3.10 — primer bloque = vigente).
// Uso: soffice --headless --convert-to xlsx docs/sri/Catalogo_ATS.xls --outdir /tmp/ats
//      node tools/ats-catalog.mjs /tmp/ats/Catalogo_ATS.xlsx
import ExcelJS from 'exceljs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const file = process.argv[2];
if (!file) throw new Error('Indique la ruta del Catalogo_ATS.xlsx convertido');
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(file);
const ws = wb.getWorksheet('TABLAS RETENCIONES');
const text = (c) => {
  const v = c.value;
  if (v == null) return '';
  if (typeof v === 'object') return v.richText ? v.richText.map((r) => r.text).join('') : v.result !== undefined ? String(v.result) : String(v);
  return String(v);
};
const clean = (s) => s.replace(/\s+/g, ' ').trim();

// Fila 2: "DESDE 06/AGOSTO/2026" → fecha de vigencia del bloque
const header = clean(text(ws.getRow(2).getCell(2)));
const m = /DESDE (\d{2})\/([A-ZÁÉÍÓÚ]+)\/(\d{4})/i.exec(header);
const MONTHS = { ENERO: 1, FEBRERO: 2, MARZO: 3, ABRIL: 4, MAYO: 5, JUNIO: 6, JULIO: 7, AGOSTO: 8, SEPTIEMBRE: 9, OCTUBRE: 10, NOVIEMBRE: 11, DICIEMBRE: 12 };
if (!m) throw new Error(`No se encontró la fecha de vigencia en: ${header}`);
const validFrom = `${m[3]}-${String(MONTHS[m[2].toUpperCase()]).padStart(2, '0')}-${m[1]}`;

const rows = [];
ws.eachRow((r, i) => {
  if (i < 5) return;
  const module = clean(text(r.getCell(2)));
  const code = clean(text(r.getCell(3))).replace(/\s+/g, '');
  const description = clean(text(r.getCell(4)));
  const pct = clean(text(r.getCell(5)));
  if (!/CÓDIGOS PARA PAGO/i.test(module) || !code) return;
  const numeric = /^\d+([.,]\d+)?$/.test(pct) ? pct.replace(',', '.') : null;
  rows.push({
    code,
    description: description.slice(0, 500),
    percentage: numeric,
    percentageNote: numeric ? null : pct.slice(0, 300),
    residence: /NO RESIDENTE/i.test(module) ? 'NON_RESIDENT' : 'RESIDENT',
  });
});

const out = `// GENERADO por tools/ats-catalog.mjs — no editar a mano.
// Fuente: Catálogo ATS del SRI (docs/sri/Catalogo_ATS.xls), Tabla 3.10 "Conceptos de retención en la fuente
// de impuesto a la renta", ${header}. Los conceptos con porcentaje variable ("12 o 14", "varios porcentajes")
// quedan sin porcentaje: se ingresa al retener según la normativa (percentageNote = texto oficial).
export const RENTA_VALID_FROM = '${validFrom}';
export const RENTA_CONCEPTS: { code: string; description: string; percentage: string | null; percentageNote: string | null; residence: 'RESIDENT' | 'NON_RESIDENT' }[] = ${JSON.stringify(rows, null, 2)};
`;
writeFileSync(join(import.meta.dirname, '..', 'libs', 'db', 'src', 'lib', 'withholding-catalog.generated.ts'), out);
console.log(`Conceptos de renta: ${rows.length} (vigentes desde ${validFrom}); con porcentaje variable: ${rows.filter((r) => !r.percentage).length}`);
