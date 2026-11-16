import { PrismaClient } from '../generated/prisma/client';
import { uuidv7 } from './uuid';

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
  { key: 'provider_ruc', value: null, note: 'Ficha v2.34 Anexo 26 (Res. NAC-DGERCGC26-00000027): RUC del proveedor del sistema en <infoAdicional> "RUC Proveedor"' },
];

export async function seedSriConfig(prisma: PrismaClient): Promise<void> {
  for (const r of SEED_IVA_RATES) {
    const exists = await prisma.taxRate.findFirst({ where: { taxCode: '2', percentageCode: r.percentageCode } });
    if (!exists) await prisma.taxRate.create({ data: { id: uuidv7(), taxCode: '2', ...r } });
  }
  const catalogs: [string, readonly (readonly [string, string])[]][] = [
    ['payment_method', SEED_PAYMENT_METHODS],
    ['id_type', SEED_ID_TYPES],
    ['doc_type', SEED_DOC_TYPES],
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
  for (const s of SEED_SETTINGS) {
    const exists = await prisma.sriSetting.findUnique({ where: { key: s.key } });
    if (!exists) await prisma.sriSetting.create({ data: { key: s.key, value: s.value as object, note: s.note } });
  }
}
