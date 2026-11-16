import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Tx, uuidv7 } from '@vektra/db';
import { applyMovement, InventoryError } from '@vektra/inventory';
import type { ImportKind, ImportPreview, ImportResult, ImportRowError } from '@vektra/shared-contracts';
import Decimal from 'decimal.js';
import ExcelJS from 'exceljs';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../common/prisma.service';
import { currentContext } from '../common/request-context';
import { identificationError } from './parties.controller';

/**
 * Importación masiva desde Excel: plantilla descargable → vista previa con errores fila por fila →
 * confirmación por lotes. Las filas válidas se guardan normalizadas en import_job hasta confirmar.
 */

interface ColumnDef {
  key: string;
  header: string;
  required?: boolean;
  note: string;
  example: string;
  width?: number;
  list?: string[];
}

const MAX_ROWS = 10_000;
const CHUNK = 250;
const D = Decimal.clone({ rounding: Decimal.ROUND_HALF_UP });

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\*/g, '')
    .trim()
    .replace(/[\s/]+/g, '_');

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue);
    if ('richText' in v) return v.richText.map((t) => t.text).join('').trim();
    if ('text' in v) return String(v.text).trim();
    if ('error' in v) return '';
  }
  return String(v).trim();
}

const yes = (v: string, dflt: boolean) => (v === '' ? dflt : ['si', 'sí', 's', 'x', '1', 'true', 'verdadero', 'yes'].includes(v.toLowerCase()));
const isYesNo = (v: string) => v === '' || ['si', 'sí', 's', 'x', '1', 'true', 'verdadero', 'yes', 'no', 'n', '0', 'false', 'falso'].includes(v.toLowerCase());
const decimalOk = (v: string, max = 6) => new RegExp(`^\\d{1,12}([.,]\\d{1,${max}})?$`).test(v);
const toDec = (v: string) => v.replace(',', '.');

type ProductRow = {
  row: number;
  code: string;
  name: string;
  description: string | null;
  category: string | null;
  brand: string | null;
  unitId: string;
  taxRateId: string;
  auxCode: string | null;
  isService: boolean;
  minStock: string;
  barcodes: string[];
  prices: Record<string, string>;
};
type PartyRow = {
  row: number;
  idType: string;
  identification: string;
  name: string;
  tradeName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  isCustomer: boolean;
  isSupplier: boolean;
  priceListId: string | null;
  creditLimit: string;
  creditDays: number;
};
type StockRow = { row: number; productId: string; warehouseId: string; quantity: string; unitCost: string };

@Injectable()
export class ImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ───────── Definición de columnas (dinámicas según la empresa) ─────────

  private async columns(kind: ImportKind): Promise<ColumnDef[]> {
    if (kind === 'products') {
      const { units, lists, rates } = await this.refs();
      return [
        { key: 'codigo', header: 'Código', required: true, note: 'Código interno único del producto (máx. 25)', example: 'MART-016', width: 14 },
        { key: 'nombre', header: 'Nombre', required: true, note: 'Nombre que aparece en la factura (máx. 300)', example: 'Martillo de uña 16 oz', width: 36 },
        { key: 'codigo_barras', header: 'Código de barras', note: 'Uno o varios separados por punto y coma', example: '7861234567890', width: 18 },
        { key: 'categoria', header: 'Categoría', note: 'Se crea si no existe', example: 'Herramientas', width: 16 },
        { key: 'marca', header: 'Marca', note: 'Se crea si no existe', example: 'Stanley', width: 14 },
        { key: 'unidad', header: 'Unidad', note: `Código de unidad: ${units.map((u) => u.code).join(', ')} (por defecto UND)`, example: 'UND', width: 10, list: units.map((u) => u.code) },
        { key: 'iva', header: 'IVA', note: `Tarifa: ${rates.map((r) => r.label).join(', ')} (por defecto 15%)`, example: '15%', width: 10, list: rates.map((r) => r.label) },
        ...lists.map((l) => ({
          key: `precio_${l.code.toLowerCase()}`,
          header: `Precio ${l.name}`,
          required: l.isDefault,
          note: `Precio de la lista ${l.name}${l.isDefault ? ' (obligatorio)' : ''}`,
          example: l.isDefault ? '12.50' : '',
          width: 14,
        })),
        { key: 'precio_incluye_iva', header: 'Precio incluye IVA', note: 'SI si los precios ya tienen IVA (PVP); NO si son sin IVA. Por defecto NO', example: 'NO', width: 12, list: ['SI', 'NO'] },
        { key: 'stock_minimo', header: 'Stock mínimo', note: 'Para la alerta de stock bajo', example: '5', width: 12 },
        { key: 'servicio', header: 'Servicio', note: 'SI para servicios (no llevan stock). Por defecto NO', example: 'NO', width: 10, list: ['SI', 'NO'] },
        { key: 'codigo_auxiliar', header: 'Código auxiliar', note: 'Opcional. Materiales de construcción: código del Anexo 23 del SRI (ej. F010401)', example: '', width: 14 },
        { key: 'descripcion', header: 'Descripción', note: 'Opcional', example: '', width: 30 },
      ];
    }
    if (kind === 'parties') {
      const { lists } = await this.refs();
      return [
        { key: 'tipo_identificacion', header: 'Tipo identificación', note: 'RUC, CEDULA, PASAPORTE o EXTERIOR (si se omite se deduce: 13 dígitos = RUC, 10 = cédula)', example: 'CEDULA', width: 16, list: ['RUC', 'CEDULA', 'PASAPORTE', 'EXTERIOR'] },
        { key: 'identificacion', header: 'Identificación', required: true, note: 'Cédula, RUC o pasaporte', example: '1710034065', width: 16 },
        { key: 'nombre', header: 'Nombre o razón social', required: true, note: 'Tal como consta en el RUC/cédula', example: 'JUAN PÉREZ', width: 30 },
        { key: 'nombre_comercial', header: 'Nombre comercial', note: 'Opcional', example: '', width: 20 },
        { key: 'email', header: 'Email', note: 'Para enviar las facturas (varios separados por coma)', example: 'cliente@correo.com', width: 24 },
        { key: 'telefono', header: 'Teléfono', note: 'Opcional', example: '0991234567', width: 14 },
        { key: 'direccion', header: 'Dirección', note: 'Opcional', example: 'Av. Loja y Remigio Crespo', width: 28 },
        { key: 'es_cliente', header: 'Es cliente', note: 'SI/NO (por defecto SI)', example: 'SI', width: 10, list: ['SI', 'NO'] },
        { key: 'es_proveedor', header: 'Es proveedor', note: 'SI/NO (por defecto NO)', example: 'NO', width: 10, list: ['SI', 'NO'] },
        { key: 'lista_precios', header: 'Lista de precios', note: `Opcional: ${lists.map((l) => l.name).join(', ')}`, example: '', width: 14, list: lists.map((l) => l.name) },
        { key: 'limite_credito', header: 'Límite de crédito', note: 'En dólares (0 = sin crédito)', example: '0', width: 12 },
        { key: 'dias_credito', header: 'Días de crédito', note: 'Plazo en días', example: '0', width: 10 },
      ];
    }
    const { warehouses } = await this.refs();
    return [
      { key: 'codigo_producto', header: 'Código producto', required: true, note: 'Código del producto ya creado', example: 'MART-016', width: 16 },
      { key: 'bodega', header: 'Bodega', note: `Nombre de la bodega (por defecto la principal): ${warehouses.map((w) => w.name).join(', ')}`, example: 'Bodega principal', width: 20, list: [...new Set(warehouses.map((w) => w.name))] },
      { key: 'cantidad', header: 'Cantidad', required: true, note: 'En la unidad base del producto', example: '24', width: 10 },
      { key: 'costo_unitario', header: 'Costo unitario', required: true, note: 'Costo SIN IVA por unidad base', example: '6.80', width: 12 },
    ];
  }

  private async refs() {
    const rates = await this.prisma.client.taxRate.findMany({ where: { active: true, taxCode: '2' }, orderBy: { sortOrder: 'asc' } });
    return this.prisma.tx(async (tx) => ({
      units: await tx.unit.findMany({ where: { active: true }, orderBy: { code: 'asc' } }),
      lists: await tx.priceList.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } }),
      warehouses: await tx.warehouse.findMany({ where: { active: true }, include: { establishment: true }, orderBy: [{ isDefault: 'desc' }, { establishment: { code: 'asc' } }] }),
      rates,
    }));
  }

  // ───────── Plantilla ─────────

  async template(kind: ImportKind): Promise<{ buffer: Buffer; fileName: string }> {
    const cols = await this.columns(kind);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Vektra POS';
    const ws = wb.addWorksheet('Datos', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = cols.map((c) => ({ header: c.required ? `${c.header}*` : c.header, key: c.key, width: c.width ?? 14 }));
    const header = ws.getRow(1);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B5560' } };
    cols.forEach((c, i) => {
      const cell = header.getCell(i + 1);
      cell.note = c.note;
      if (c.list?.length && c.list.join(',').length < 250) {
        // Validación por rango: no crea celdas, así la hoja sigue "vacía" desde la fila 2.
        const col = ws.getColumn(i + 1).letter;
        (ws as unknown as { dataValidations: { add(range: string, v: ExcelJS.DataValidation): void } }).dataValidations.add(`${col}2:${col}${MAX_ROWS + 1}`, {
          type: 'list',
          allowBlank: true,
          formulae: [`"${c.list.join(',')}"`],
        });
      }
      // Códigos como texto para no perder ceros a la izquierda
      if (['codigo', 'codigo_barras', 'identificacion', 'codigo_producto', 'telefono'].includes(c.key)) ws.getColumn(i + 1).numFmt = '@';
    });

    const help = wb.addWorksheet('Instrucciones');
    help.columns = [
      { header: 'Columna', width: 24 },
      { header: 'Obligatoria', width: 12 },
      { header: 'Descripción', width: 70 },
      { header: 'Ejemplo', width: 20 },
    ];
    help.getRow(1).font = { bold: true };
    for (const c of cols) help.addRow([c.header, c.required ? 'Sí' : 'No', c.note, c.example]);
    help.addRow([]);
    help.addRow(['Llene la hoja "Datos" a partir de la fila 2. Si un código ya existe, la fila ACTUALIZA el registro.']);
    help.addRow(['Antes de importar verá una vista previa con los errores de cada fila; nada se guarda hasta confirmar.']);

    const names: Record<ImportKind, string> = { products: 'productos', parties: 'clientes-proveedores', initial_stock: 'saldos-iniciales' };
    return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), fileName: `plantilla-${names[kind]}.xlsx` };
  }

  // ───────── Vista previa ─────────

  async preview(kind: ImportKind, fileName: string, data: Buffer): Promise<ImportPreview> {
    const cols = await this.columns(kind);
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(data as unknown as ArrayBuffer);
    } catch {
      throw new BadRequestException('El archivo no es un Excel (.xlsx) válido');
    }
    const ws = wb.getWorksheet('Datos') ?? wb.worksheets[0];
    if (!ws) throw new BadRequestException('El archivo no tiene hojas');

    // Mapear encabezados → claves
    const colIndex = new Map<string, number>();
    ws.getRow(1).eachCell((cell, i) => {
      const h = norm(cellText(cell.value));
      const def = cols.find((c) => norm(c.header) === h || c.key === h);
      if (def) colIndex.set(def.key, i);
    });
    const missing = cols.filter((c) => c.required && !colIndex.has(c.key)).map((c) => c.header);
    if (missing.length) throw new BadRequestException(`Faltan columnas obligatorias: ${missing.join(', ')}. Descargue la plantilla.`);

    const raw: { row: number; v: Record<string, string> }[] = [];
    ws.eachRow({ includeEmpty: false }, (r, rowNumber) => {
      if (rowNumber === 1) return;
      const v: Record<string, string> = {};
      for (const [key, idx] of colIndex) v[key] = cellText(r.getCell(idx).value);
      if (Object.values(v).some((x) => x !== '')) raw.push({ row: rowNumber, v });
    });
    if (raw.length === 0) throw new BadRequestException('La hoja "Datos" no tiene filas');
    if (raw.length > MAX_ROWS) throw new BadRequestException(`Máximo ${MAX_ROWS} filas por archivo`);

    const header = (key: string) => cols.find((c) => c.key === key)?.header ?? key;
    const errors: ImportRowError[] = [];
    const err = (row: number, key: string, message: string) => errors.push({ row, column: header(key), message });

    let valid: (ProductRow | PartyRow | StockRow)[] = [];
    let updates = 0;
    if (kind === 'products') ({ rows: valid, updates } = await this.validateProducts(raw, err));
    else if (kind === 'parties') ({ rows: valid, updates } = await this.validateParties(raw, err));
    else valid = await this.validateStock(raw, err);

    const badRows = new Set(errors.map((e) => e.row));
    valid = valid.filter((r) => !badRows.has(r.row));
    const id = uuidv7();
    const ctx = currentContext();
    await this.prisma.tx((tx) =>
      tx.importJob.create({
        data: {
          id,
          tenantId: ctx.tenantId as string,
          kind,
          fileName: fileName.slice(0, 300),
          total: raw.length,
          validCount: valid.length,
          errors: errors.slice(0, 5000) as unknown as Prisma.InputJsonValue,
          rows: valid as unknown as Prisma.InputJsonValue,
          createdBy: ctx.userId ?? null,
        },
      }),
    );
    return {
      id,
      kind,
      fileName,
      total: raw.length,
      valid: valid.length,
      errors: errors.sort((a, b) => a.row - b.row).slice(0, 1000),
      sample: valid.slice(0, 10).map((r) => this.sampleView(kind, r)),
      updates,
    };
  }

  private sampleView(kind: ImportKind, r: ProductRow | PartyRow | StockRow): Record<string, unknown> {
    if (kind === 'products') {
      const p = r as ProductRow;
      return { fila: p.row, código: p.code, nombre: p.name, categoría: p.category, precios: Object.keys(p.prices).length };
    }
    if (kind === 'parties') {
      const p = r as PartyRow;
      return { fila: p.row, identificación: p.identification, nombre: p.name, email: p.email };
    }
    const s = r as StockRow;
    return { fila: s.row, cantidad: s.quantity, costo: s.unitCost };
  }

  private async validateProducts(raw: { row: number; v: Record<string, string> }[], err: (r: number, k: string, m: string) => void) {
    const { units, lists, rates } = await this.refs();
    const unitByCode = new Map(units.map((u) => [u.code.toUpperCase(), u]));
    const rateByKey = new Map<string, string>();
    for (const r of rates) {
      for (const k of [r.label, r.name, `${Number(r.rate)}`, `${Number(r.rate)}%`, `iva ${Number(r.rate)}%`]) {
        if (!rateByKey.has(norm(k))) rateByKey.set(norm(k), r.id);
      }
    }
    const defaultRate = rates.find((r) => r.percentageCode === '4')?.id;
    const rateValue = new Map(rates.map((r) => [r.id, r.rate.toString()]));
    const seenCodes = new Map<string, number>();
    const seenBarcodes = new Map<string, number>();
    const rows: ProductRow[] = [];

    for (const { row, v } of raw) {
      const code = v['codigo'] ?? '';
      const name = v['nombre'] ?? '';
      if (!code) err(row, 'codigo', 'Obligatorio');
      else if (code.length > 25) err(row, 'codigo', 'Máximo 25 caracteres');
      else if (seenCodes.has(code.toLowerCase())) err(row, 'codigo', `Repetido en el archivo (fila ${seenCodes.get(code.toLowerCase())})`);
      else seenCodes.set(code.toLowerCase(), row);
      if (!name) err(row, 'nombre', 'Obligatorio');
      else if (name.length > 300) err(row, 'nombre', 'Máximo 300 caracteres');

      const unit = unitByCode.get((v['unidad'] || 'UND').toUpperCase());
      if (!unit) err(row, 'unidad', `Unidad "${v['unidad']}" no existe`);
      const taxRateId = v['iva'] ? rateByKey.get(norm(v['iva'])) : defaultRate;
      if (!taxRateId) err(row, 'iva', `Tarifa "${v['iva']}" no reconocida`);

      const includesTax = v['precio_incluye_iva'] ?? '';
      if (!isYesNo(includesTax)) err(row, 'precio_incluye_iva', 'Use SI o NO');
      const prices: Record<string, string> = {};
      for (const l of lists) {
        const key = `precio_${l.code.toLowerCase()}`;
        const val = v[key] ?? '';
        if (!val) {
          if (l.isDefault) err(row, key, 'Obligatorio');
          continue;
        }
        if (!decimalOk(val)) {
          err(row, key, `"${val}" no es un precio válido`);
          continue;
        }
        let net = new D(toDec(val));
        if (yes(includesTax, false) && taxRateId) net = net.div(new D(rateValue.get(taxRateId) ?? '0').div(100).plus(1));
        prices[l.id] = net.toDecimalPlaces(6).toFixed(6);
      }
      const minStock = v['stock_minimo'] || '0';
      if (!decimalOk(minStock)) err(row, 'stock_minimo', `"${minStock}" no es un número válido`);
      if (!isYesNo(v['servicio'] ?? '')) err(row, 'servicio', 'Use SI o NO');
      const barcodes = (v['codigo_barras'] ?? '').split(/[;,]/).map((b) => b.trim()).filter(Boolean);
      for (const b of barcodes) {
        if (b.length > 64) err(row, 'codigo_barras', `"${b}" demasiado largo`);
        else if (seenBarcodes.has(b)) err(row, 'codigo_barras', `${b} repetido en el archivo (fila ${seenBarcodes.get(b)})`);
        else seenBarcodes.set(b, row);
      }
      if ((v['codigo_auxiliar'] ?? '').length > 25) err(row, 'codigo_auxiliar', 'Máximo 25 caracteres');
      if (unit && unit.allowsDecimal === false && v['stock_minimo'] && !/^\d+$/.test(v['stock_minimo'])) {
        err(row, 'stock_minimo', `La unidad ${unit.code} no admite decimales`);
      }
      rows.push({
        row,
        code,
        name,
        description: v['descripcion'] || null,
        category: v['categoria'] || null,
        brand: v['marca'] || null,
        unitId: unit?.id ?? '',
        taxRateId: taxRateId ?? '',
        auxCode: v['codigo_auxiliar'] || null,
        isService: yes(v['servicio'] ?? '', false),
        minStock: toDec(minStock),
        barcodes,
        prices,
      });
    }

    // Contra la base: códigos existentes (se actualizan) y códigos de barras de OTROS productos.
    const { existing, taken } = await this.prisma.tx(async (tx) => ({
      existing: await tx.product.findMany({ where: { code: { in: rows.map((r) => r.code).filter(Boolean) } }, select: { code: true } }),
      taken: await tx.productBarcode.findMany({ where: { barcode: { in: [...seenBarcodes.keys()] } }, include: { product: { select: { code: true } } } }),
    }));
    const byBarcode = new Map(taken.map((t) => [t.barcode, t.product.code]));
    for (const r of rows) {
      for (const b of r.barcodes) {
        const owner = byBarcode.get(b);
        if (owner && owner !== r.code) err(r.row, 'codigo_barras', `${b} ya pertenece al producto ${owner}`);
      }
    }
    return { rows, updates: existing.length };
  }

  private async validateParties(raw: { row: number; v: Record<string, string> }[], err: (r: number, k: string, m: string) => void) {
    const { lists } = await this.refs();
    const listByKey = new Map(lists.flatMap((l) => [[norm(l.name), l.id] as const, [norm(l.code), l.id] as const]));
    const types: Record<string, string> = { ruc: '04', '04': '04', cedula: '05', '05': '05', pasaporte: '06', '06': '06', exterior: '08', '08': '08' };
    const seen = new Map<string, number>();
    const rows: PartyRow[] = [];
    for (const { row, v } of raw) {
      const id = (v['identificacion'] ?? '').replace(/\s/g, '');
      const typeRaw = norm(v['tipo_identificacion'] ?? '');
      const idType = typeRaw ? types[typeRaw] : id.length === 13 ? '04' : id.length === 10 ? '05' : undefined;
      if (!id) err(row, 'identificacion', 'Obligatorio');
      else if (seen.has(id)) err(row, 'identificacion', `Repetida en el archivo (fila ${seen.get(id)})`);
      else seen.set(id, row);
      if (!idType) err(row, 'tipo_identificacion', 'Indique RUC, CEDULA, PASAPORTE o EXTERIOR');
      else if (id) {
        const e = identificationError(idType, id);
        if (e) err(row, 'identificacion', e);
      }
      if (!v['nombre']) err(row, 'nombre', 'Obligatorio');
      const email = v['email'] || null;
      if (email && !email.split(/[;,]/).every((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()))) err(row, 'email', `"${email}" no es un correo válido`);
      for (const k of ['es_cliente', 'es_proveedor']) if (!isYesNo(v[k] ?? '')) err(row, k, 'Use SI o NO');
      const isCustomer = yes(v['es_cliente'] ?? '', true);
      const isSupplier = yes(v['es_proveedor'] ?? '', false);
      if (!isCustomer && !isSupplier) err(row, 'es_cliente', 'Debe ser cliente, proveedor o ambos');
      const priceListId = v['lista_precios'] ? listByKey.get(norm(v['lista_precios'])) : null;
      if (v['lista_precios'] && !priceListId) err(row, 'lista_precios', `Lista "${v['lista_precios']}" no existe`);
      const credit = v['limite_credito'] || '0';
      if (!decimalOk(credit, 2)) err(row, 'limite_credito', `"${credit}" no es un valor válido`);
      const days = v['dias_credito'] || '0';
      if (!/^\d{1,4}$/.test(days)) err(row, 'dias_credito', `"${days}" no es un número de días válido`);
      rows.push({
        row,
        idType: idType ?? '',
        identification: id,
        name: (v['nombre'] ?? '').slice(0, 300),
        tradeName: v['nombre_comercial'] || null,
        email,
        phone: v['telefono'] || null,
        address: v['direccion'] || null,
        isCustomer,
        isSupplier,
        priceListId: priceListId ?? null,
        creditLimit: toDec(credit),
        creditDays: Number(days) || 0,
      });
    }
    const existing = await this.prisma.tx((tx) => tx.party.count({ where: { identification: { in: rows.map((r) => r.identification) } } }));
    return { rows, updates: existing };
  }

  private async validateStock(raw: { row: number; v: Record<string, string> }[], err: (r: number, k: string, m: string) => void): Promise<StockRow[]> {
    const { warehouses } = await this.refs();
    const defaultWh = warehouses.find((w) => w.isDefault && w.establishment.code === '001') ?? warehouses.find((w) => w.isDefault) ?? warehouses[0];
    const whByName = new Map<string, string>();
    for (const w of warehouses) if (!whByName.has(norm(w.name))) whByName.set(norm(w.name), w.id);
    const codes = [...new Set(raw.map((r) => r.v['codigo_producto']).filter(Boolean))];
    const products = await this.prisma.tx((tx) => tx.product.findMany({ where: { code: { in: codes } }, select: { id: true, code: true, isService: true, unitId: true } }));
    const unitIds = [...new Set(products.map((p) => p.unitId))];
    const units = await this.prisma.tx((tx) => tx.unit.findMany({ where: { id: { in: unitIds } } }));
    const unitById = new Map(units.map((u) => [u.id, u]));
    const productByCode = new Map(products.map((p) => [p.code.toLowerCase(), p]));
    const rows: StockRow[] = [];
    for (const { row, v } of raw) {
      const p = productByCode.get((v['codigo_producto'] ?? '').toLowerCase());
      if (!v['codigo_producto']) err(row, 'codigo_producto', 'Obligatorio');
      else if (!p) err(row, 'codigo_producto', `El producto ${v['codigo_producto']} no existe (impórtelo primero)`);
      else if (p.isService) err(row, 'codigo_producto', 'Es un servicio: no lleva inventario');
      const warehouseId = v['bodega'] ? whByName.get(norm(v['bodega'])) : defaultWh?.id;
      if (!warehouseId) err(row, 'bodega', `Bodega "${v['bodega']}" no existe`);
      const q = v['cantidad'] ?? '';
      if (!decimalOk(q) || new D(toDec(q)).lte(0)) err(row, 'cantidad', 'Debe ser un número mayor a cero');
      else if (p && unitById.get(p.unitId)?.allowsDecimal === false && !/^\d+$/.test(q)) err(row, 'cantidad', `La unidad ${unitById.get(p.unitId)?.code} no admite decimales`);
      const c = v['costo_unitario'] ?? '';
      if (!decimalOk(c)) err(row, 'costo_unitario', `"${c}" no es un costo válido`);
      rows.push({ row, productId: p?.id ?? '', warehouseId: warehouseId ?? '', quantity: toDec(q), unitCost: toDec(c) });
    }
    return rows;
  }

  // ───────── Confirmación ─────────

  async commit(id: string): Promise<ImportResult> {
    const ctx = currentContext();
    const tenantId = ctx.tenantId as string;
    const job = await this.prisma.tx((tx) => tx.importJob.findFirst({ where: { id } }));
    if (!job) throw new NotFoundException('Importación no encontrada');
    if (job.status !== 'PREVIEW') throw new ConflictException('Esta importación ya fue procesada');
    const needed = { products: 'catalog.manage', parties: 'customers.manage', initial_stock: 'inventory.adjust' }[job.kind as ImportKind];
    if (!ctx.permissions?.has(needed)) throw new ForbiddenException('No tiene permiso para esta importación');
    const started = Date.now();
    let result: Omit<ImportResult, 'ms'> = { created: 0, updated: 0, skipped: 0 };
    try {
      if (job.kind === 'products') result = await this.commitProducts(tenantId, job.rows as unknown as ProductRow[]);
      else if (job.kind === 'parties') result = await this.commitParties(tenantId, job.rows as unknown as PartyRow[]);
      else result = await this.commitStock(tenantId, ctx.userId ?? null, job.rows as unknown as StockRow[]);
    } catch (e) {
      await this.prisma.tx((tx) => tx.importJob.update({ where: { id }, data: { status: 'FAILED', result: { error: (e as Error).message } } }));
      if (e instanceof InventoryError) throw new ConflictException(e.message);
      throw e;
    }
    const final: ImportResult = { ...result, ms: Date.now() - started };
    await this.prisma.tx(async (tx) => {
      await tx.importJob.update({ where: { id }, data: { status: 'COMMITTED', committedAt: new Date(), result: final as unknown as Prisma.InputJsonValue, rows: [] } });
      await this.audit.record(tx, { action: 'import', entity: job.kind, entityId: id, after: { fileName: job.fileName, ...final } });
    });
    return final;
  }

  private async ensureNamed(tx: Tx, tenantId: string, model: 'category' | 'brand', names: string[]): Promise<Map<string, string>> {
    const unique = [...new Map(names.filter(Boolean).map((n) => [n.toLowerCase(), n])).values()];
    const delegate = model === 'category' ? tx.category : tx.brand;
    const existing = await (delegate as typeof tx.category).findMany({ where: { name: { in: unique, mode: 'insensitive' } } });
    const map = new Map(existing.map((e) => [e.name.toLowerCase(), e.id]));
    const missing = unique.filter((n) => !map.has(n.toLowerCase()));
    if (missing.length) {
      const rows = missing.map((name) => ({ id: uuidv7(), tenantId, name }));
      await (delegate as typeof tx.category).createMany({ data: rows });
      for (const r of rows) map.set(r.name.toLowerCase(), r.id);
    }
    return map;
  }

  private async commitProducts(tenantId: string, rows: ProductRow[]) {
    let created = 0;
    let updated = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      await this.prisma.tx(async (tx) => {
        const cats = await this.ensureNamed(tx, tenantId, 'category', chunk.map((r) => r.category ?? ''));
        const brands = await this.ensureNamed(tx, tenantId, 'brand', chunk.map((r) => r.brand ?? ''));
        const existing = await tx.product.findMany({ where: { code: { in: chunk.map((r) => r.code) } }, include: { units: { where: { isBase: true } }, barcodes: true } });
        const byCode = new Map(existing.map((p) => [p.code, p]));
        const products: Prisma.ProductCreateManyInput[] = [];
        const units: Prisma.ProductUnitCreateManyInput[] = [];
        const barcodes: Prisma.ProductBarcodeCreateManyInput[] = [];
        const prices: Prisma.ProductPriceCreateManyInput[] = [];
        for (const r of chunk) {
          const cols = {
            name: r.name,
            description: r.description,
            categoryId: r.category ? (cats.get(r.category.toLowerCase()) ?? null) : null,
            brandId: r.brand ? (brands.get(r.brand.toLowerCase()) ?? null) : null,
            taxRateId: r.taxRateId,
            auxCode: r.auxCode,
            isService: r.isService,
            minStock: r.minStock,
          };
          const current = byCode.get(r.code);
          if (current) {
            await tx.product.update({ where: { id: current.id }, data: cols });
            const baseUnit = current.units[0];
            if (baseUnit) {
              await tx.productPrice.deleteMany({ where: { productUnitId: baseUnit.id, priceListId: { in: Object.keys(r.prices) } } });
              for (const [priceListId, price] of Object.entries(r.prices)) prices.push({ id: uuidv7(), tenantId, productId: current.id, priceListId, productUnitId: baseUnit.id, price });
              const have = new Set(current.barcodes.map((b) => b.barcode));
              for (const b of r.barcodes) if (!have.has(b)) barcodes.push({ id: uuidv7(), tenantId, productId: current.id, productUnitId: baseUnit.id, barcode: b });
            }
            updated++;
          } else {
            const id = uuidv7();
            const unitRowId = uuidv7();
            products.push({ id, tenantId, code: r.code, unitId: r.unitId, ...cols });
            units.push({ id: unitRowId, tenantId, productId: id, unitId: r.unitId, factor: '1', isBase: true });
            for (const b of r.barcodes) barcodes.push({ id: uuidv7(), tenantId, productId: id, productUnitId: unitRowId, barcode: b });
            for (const [priceListId, price] of Object.entries(r.prices)) prices.push({ id: uuidv7(), tenantId, productId: id, priceListId, productUnitId: unitRowId, price });
            created++;
          }
        }
        if (products.length) await tx.product.createMany({ data: products });
        if (units.length) await tx.productUnit.createMany({ data: units });
        if (barcodes.length) await tx.productBarcode.createMany({ data: barcodes });
        if (prices.length) await tx.productPrice.createMany({ data: prices });
      });
    }
    return { created, updated, skipped: 0 };
  }

  private async commitParties(tenantId: string, rows: PartyRow[]) {
    let created = 0;
    let updated = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      await this.prisma.tx(async (tx) => {
        const existing = await tx.party.findMany({ where: { identification: { in: chunk.map((r) => r.identification) } }, select: { id: true, identification: true } });
        const byId = new Map(existing.map((e) => [e.identification, e.id]));
        const fresh: Prisma.PartyCreateManyInput[] = [];
        for (const { row: _row, ...r } of chunk) {
          const current = byId.get(r.identification);
          if (current) {
            await tx.party.update({ where: { id: current }, data: r });
            updated++;
          } else {
            fresh.push({ id: uuidv7(), tenantId, ...r });
            created++;
          }
        }
        if (fresh.length) await tx.party.createMany({ data: fresh });
      });
    }
    return { created, updated, skipped: 0 };
  }

  private async commitStock(tenantId: string, userId: string | null, rows: StockRow[]) {
    const batchId = uuidv7();
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      await this.prisma.tx(async (tx) => {
        for (const r of chunk) {
          await applyMovement(tx, {
            tenantId,
            productId: r.productId,
            warehouseId: r.warehouseId,
            type: 'INITIAL',
            quantity: r.quantity,
            unitCost: r.unitCost,
            allowNegative: true,
            batchId,
            reason: 'Saldo inicial (importación Excel)',
            userId,
          });
        }
      });
    }
    return { created: rows.length, updated: 0, skipped: 0 };
  }

  async history() {
    const rows = await this.prisma.tx((tx) => tx.importJob.findMany({ orderBy: { createdAt: 'desc' }, take: 30, select: { id: true, kind: true, status: true, fileName: true, total: true, validCount: true, result: true, createdAt: true, committedAt: true } }));
    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), committedAt: r.committedAt?.toISOString() ?? null }));
  }
}
