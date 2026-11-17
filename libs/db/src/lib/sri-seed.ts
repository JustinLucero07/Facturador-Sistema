import { PrismaClient } from '../generated/prisma/client';
import { uuidv7 } from './uuid';
import { RENTA_CONCEPTS, RENTA_VALID_FROM } from './withholding-catalog.generated';

/**
 * Datos iniciales de configuración tributaria, transcritos de la
 * Ficha Técnica de Comprobantes Electrónicos — Esquema Offline v2.34 (SRI, 27/07/2026).
 * Son VALORES INICIALES: se editan desde el sistema; el seed no sobrescribe cambios.
 */

/** Tabla 17: tarifas del IVA. Activas por defecto las vigentes de uso común (0 %, 5 %, 15 %, no objeto, exento). */
export const SEED_IVA_RATES = [
  { percentageCode: '0', name: 'IVA 0%', label: '0%', rate: '0', active: true, sortOrder: 10 },
  { percentageCode: '4', name: 'IVA 15%', label: '15%', rate: '15', active: true, sortOrder: 1 },
  { percentageCode: '5', name: 'IVA 5% (materiales de construcción)', label: '5%', rate: '5', active: true, sortOrder: 5 },
  { percentageCode: '6', name: 'No objeto de IVA', label: 'NO OBJETO DE IVA', rate: '0', active: true, sortOrder: 20 },
  { percentageCode: '7', name: 'Exento de IVA', label: 'EXENTO DE IVA', rate: '0', active: true, sortOrder: 21 },
  { percentageCode: '2', name: 'IVA 12% (histórico)', label: '12%', rate: '12', active: false, sortOrder: 90 },
  { percentageCode: '3', name: 'IVA 14% (histórico)', label: '14%', rate: '14', active: false, sortOrder: 91 },
  { percentageCode: '10', name: 'IVA 13%', label: '13%', rate: '13', active: false, sortOrder: 92 },
  // Código 8 "IVA diferenciado" (tarifa especial de turismo): su porcentaje lo fija la normativa vigente → se crea inactivo y sin tarifa.
  { percentageCode: '8', name: 'IVA diferenciado (configurar tarifa)', label: 'TARIFA ESPECIAL', rate: '0', active: false, sortOrder: 93 },
];

/** Tabla 24: formas de pago. */
export const SEED_PAYMENT_METHODS = [
  ['01', 'SIN UTILIZACION DEL SISTEMA FINANCIERO'],
  ['15', 'COMPENSACIÓN DE DEUDAS'],
  ['16', 'TARJETA DE DÉBITO'],
  ['17', 'DINERO ELECTRÓNICO'],
  ['18', 'TARJETA PREPAGO'],
  ['19', 'TARJETA DE CRÉDITO'],
  ['20', 'OTROS CON UTILIZACIÓN DEL SISTEMA FINANCIERO'],
  ['21', 'ENDOSO DE TÍTULOS'],
] as const;

/** Tabla 6: tipos de identificación. */
export const SEED_ID_TYPES = [
  ['04', 'RUC'],
  ['05', 'CÉDULA'],
  ['06', 'PASAPORTE'],
  ['07', 'VENTA A CONSUMIDOR FINAL'],
  ['08', 'IDENTIFICACIÓN DEL EXTERIOR'],
] as const;

/** Tabla 3: tipos de comprobante. */
export const SEED_DOC_TYPES = [
  ['01', 'FACTURA'],
  ['03', 'LIQUIDACIÓN DE COMPRA DE BIENES Y PRESTACIÓN DE SERVICIOS'],
  ['04', 'NOTA DE CRÉDITO'],
  ['05', 'NOTA DE DÉBITO'],
  ['06', 'GUÍA DE REMISIÓN'],
  ['07', 'COMPROBANTE DE RETENCIÓN'],
] as const;

export const SEED_SETTINGS: { key: string; value: unknown; note: string }[] = [
  {
    key: 'ws.test',
    value: {
      reception: 'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline',
      authorization: 'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline',
    },
    note: 'Ficha v2.34 numeral 7.2.1 — ambiente de pruebas',
  },
  {
    key: 'ws.production',
    value: {
      reception: 'https://cel.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline',
      authorization: 'https://cel.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline',
    },
    note: 'Ficha v2.34 numeral 7.2.2 — ambiente de producción',
  },
  { key: 'ws.timeout_ms', value: 30000, note: 'Tiempo máximo de espera por llamada al SRI' },
  { key: 'authorization.wait_seconds', value: 3, note: 'Espera entre RECIBIDA y la consulta de autorización (numeral 7.4: parametrizable)' },
  { key: 'final_consumer', value: { id: '9999999999999', name: 'CONSUMIDOR FINAL', maxAmount: '50.00' }, note: 'Ficha v2.34 numerales 5.7 y 9.10: sobre este monto se debe identificar al adquirente' },
  {
    key: 'rimpe_legends',
    value: { RIMPE_EMPRENDEDOR: 'CONTRIBUYENTE RÉGIMEN RIMPE', RIMPE_NEGOCIO_POPULAR: 'CONTRIBUYENTE NEGOCIO POPULAR - RÉGIMEN RIMPE' },
    note: 'Ficha v2.34 Anexo 22',
  },
  { key: 'xml_versions', value: { '01': '1.1.0' }, note: 'Versión del XML por tipo de comprobante (XSD disponibles: factura 1.1.0 y 2.1.0)' },
  { key: 'currency', value: 'DOLAR', note: 'Etiqueta <moneda>' },
  {
    key: 'payment_methods',
    value: [
      { method: 'efectivo', label: 'Efectivo', sriCode: '01', cash: true },
      { method: 'tarjeta_debito', label: 'Tarjeta de débito', sriCode: '16', reference: true },
      { method: 'tarjeta_credito', label: 'Tarjeta de crédito', sriCode: '19', reference: true },
      { method: 'transferencia', label: 'Transferencia', sriCode: '20', reference: true },
      { method: 'deuna', label: 'Deuna', sriCode: '20', reference: true },
      { method: 'payphone', label: 'Payphone', sriCode: '19', reference: true },
      { method: 'credito', label: 'Crédito', sriCode: '01', credit: true },
    ],
    note: 'Medio de pago del POS → código de la Tabla 24 (formas de pago). Confirme con su contador Deuna, Payphone y crédito.',
  },
  { key: 'desktop.max_offline_hours', value: 48, note: 'Horas que una caja de escritorio puede vender sin sincronizar con el servidor' },
  {
    key: 'offline.send_deadline_hours',
    value: null,
    note: 'Plazo para enviar al SRI un comprobante emitido sin conexión (error 65 "Fecha de emisión extemporánea"). La Ficha v2.34 no lo fija: confirmar con el contador. null = solo alertar por antigüedad',
  },
  {
    key: 'ats',
    value: {
      paymentFormThreshold: '500.00',
      noWithholdingConcept: '332',
      includeElectronicSales: true,
      electronicSalesInTotals: true,
    },
    note: 'Ficha ATS 07/02/2025: formaPago sobre USD 500 (desde 20/12/2023); 332 = compra sin retención de renta. Confirmar con el contador si las ventas electrónicas van en el detalle y en el total de ventas',
  },
  { key: 'provider_ruc', value: null, note: 'Ficha v2.34 Anexo 26 (Res. NAC-DGERCGC26-00000027): RUC del proveedor del sistema en <infoAdicional> "RUC Proveedor"' },
];

/** Ficha v2.34, Tabla 20: códigos de retención del IVA. */
export const SEED_IVA_WITHHOLDING = [
  { code: '9', description: 'Retención IVA 10%', percentage: '10' },
  { code: '10', description: 'Retención IVA 20%', percentage: '20' },
  { code: '1', description: 'Retención IVA 30%', percentage: '30' },
  { code: '11', description: 'Retención IVA 50%', percentage: '50' },
  { code: '2', description: 'Retención IVA 70%', percentage: '70' },
  { code: '3', description: 'Retención IVA 100%', percentage: '100' },
  { code: '7', description: 'Retención en cero (Disposición Transitoria Única, Res. NAC-DGERCGC15-00000284)', percentage: '0' },
  { code: '8', description: 'No procede retención', percentage: '0' },
];

/** Catálogo ATS, Tabla 5: sustento tributario del comprobante (vigentes). */
export const SEED_ATS_SUSTENTO = [
  ['01', 'Crédito Tributario para declaración de IVA (servicios y bienes distintos de inventarios y activos fijos)'],
  ['02', 'Costo o Gasto para declaración de IR (servicios y bienes distintos de inventarios y activos fijos)'],
  ['03', 'Activo Fijo - Crédito Tributario para declaración de IVA'],
  ['04', 'Activo Fijo - Costo o Gasto para declaración de IR'],
  ['05', 'Liquidación Gastos de Viaje, hospedaje y alimentación Gastos IR (a nombre de empleados y no de la empresa)'],
  ['06', 'Inventario - Crédito Tributario para declaración de IVA'],
  ['07', 'Inventario - Costo o Gasto para declaración de IR'],
  ['08', 'Valor pagado para solicitar Reembolso de Gasto (intermediario)'],
  ['09', 'Reembolso por Siniestros'],
  ['10', 'Distribución de Dividendos, Beneficios o Utilidades'],
  ['11', 'Convenios de débito o recaudación para IFI´s'],
  ['12', 'Impuestos y retenciones presuntivos'],
  ['13', 'Valores reconocidos por entidades del sector público a favor de sujetos pasivos'],
  ['14', 'Valores facturados por socios a operadoras de transporte (que no constituyen gasto de dicha operadora)'],
  ['15', 'Pagos efectuados por consumos propios y de terceros de servicios digitales'],
] as const;

/** Catálogo ATS, Tabla 14: tipo de proveedor / cliente con pasaporte o identificación del exterior. */
export const SEED_ATS_PERSON_TYPES = [
  ['01', 'Persona natural'],
  ['02', 'Sociedad'],
] as const;

/** Catálogo ATS, Tabla 4: tipos de comprobante de compra que se registran en el sistema. */
export const SEED_ATS_DOC_TYPES = [
  ['01', 'Factura'],
  ['02', 'Nota o boleta de venta'],
  ['03', 'Liquidación de compra de Bienes o Prestación de servicios'],
] as const;

export async function seedWithholdingCodes(prisma: PrismaClient): Promise<void> {
  let order = 0;
  for (const r of SEED_IVA_WITHHOLDING) {
    const exists = await prisma.withholdingCode.findFirst({ where: { tax: '2', code: r.code } });
    if (!exists) await prisma.withholdingCode.create({ data: { id: uuidv7(), tax: '2', code: r.code, description: r.description, percentage: r.percentage, sortOrder: order } });
    order++;
  }
  const from = new Date(`${RENTA_VALID_FROM}T00:00:00Z`);
  order = 0;
  for (const r of RENTA_CONCEPTS) {
    const exists = await prisma.withholdingCode.findFirst({ where: { tax: '1', code: r.code, validFrom: from } });
    if (!exists) {
      await prisma.withholdingCode.create({
        data: {
          id: uuidv7(),
          tax: '1',
          code: r.code,
          description: r.description,
          percentage: r.percentage,
          percentageNote: r.percentageNote,
          residence: r.residence,
          validFrom: from,
          // Los pagos al exterior no se emiten todavía desde el sistema
          active: r.residence === 'RESIDENT',
          sortOrder: order,
        },
      });
    }
    order++;
  }
}

export async function seedSriConfig(prisma: PrismaClient): Promise<void> {
  for (const r of SEED_IVA_RATES) {
    const exists = await prisma.taxRate.findFirst({ where: { taxCode: '2', percentageCode: r.percentageCode } });
    if (!exists) await prisma.taxRate.create({ data: { id: uuidv7(), taxCode: '2', ...r } });
  }
  const catalogs: [string, readonly (readonly [string, string])[]][] = [
    ['payment_method', SEED_PAYMENT_METHODS],
    ['id_type', SEED_ID_TYPES],
    ['doc_type', SEED_DOC_TYPES],
    ['ats_sustento', SEED_ATS_SUSTENTO],
    ['ats_doc_type', SEED_ATS_DOC_TYPES],
    ['ats_person_type', SEED_ATS_PERSON_TYPES],
  ];
  for (const [catalog, rows] of catalogs) {
    let order = 0;
    for (const [code, description] of rows) {
      await prisma.sriCatalog.upsert({
        where: { catalog_code: { catalog, code } },
        create: { catalog, code, description, sortOrder: order++ },
        update: {},
      });
    }
  }
  await seedWithholdingCodes(prisma);
  for (const s of SEED_SETTINGS) {
    const exists = await prisma.sriSetting.findUnique({ where: { key: s.key } });
    if (!exists) await prisma.sriSetting.create({ data: { key: s.key, value: s.value as object, note: s.note } });
  }
}
