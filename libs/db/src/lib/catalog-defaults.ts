import { Tx } from './client';
import { uuidv7 } from './uuid';

/** Unidades de medida iniciales de cada empresa (editables). */
export const DEFAULT_UNITS: { code: string; name: string; allowsDecimal: boolean }[] = [
  { code: 'UND', name: 'Unidad', allowsDecimal: false },
  { code: 'KG', name: 'Kilogramo', allowsDecimal: true },
  { code: 'LB', name: 'Libra', allowsDecimal: true },
  { code: 'G', name: 'Gramo', allowsDecimal: true },
  { code: 'M', name: 'Metro', allowsDecimal: true },
  { code: 'L', name: 'Litro', allowsDecimal: true },
  { code: 'GL', name: 'Galón', allowsDecimal: true },
  { code: 'CAJA', name: 'Caja', allowsDecimal: false },
  { code: 'PAQ', name: 'Paquete', allowsDecimal: false },
  { code: 'SACO', name: 'Saco', allowsDecimal: false },
  { code: 'ROLLO', name: 'Rollo', allowsDecimal: false },
  { code: 'DOC', name: 'Docena', allowsDecimal: false },
  { code: 'PAR', name: 'Par', allowsDecimal: false },
  { code: 'SRV', name: 'Servicio', allowsDecimal: true },
];

export const DEFAULT_PRICE_LISTS = [
  { code: 'PUBLICO', name: 'Público', isDefault: true, sortOrder: 1 },
  { code: 'MAYORISTA', name: 'Mayorista', isDefault: false, sortOrder: 2 },
  { code: 'DISTRIBUIDOR', name: 'Distribuidor', isDefault: false, sortOrder: 3 },
];

/**
 * Crea (si faltan) unidades y listas de precios. Idempotente.
 * Filtra por tenantId de forma explícita: el seed y el alta de empresas pueden correr con el usuario
 * dueño de la base, que NO está sujeto a RLS.
 */
export async function ensureCatalogDefaults(tx: Tx, tenantId: string): Promise<void> {
  const units = await tx.unit.findMany({ where: { tenantId }, select: { code: true } });
  const haveUnits = new Set(units.map((u) => u.code));
  const missingUnits = DEFAULT_UNITS.filter((u) => !haveUnits.has(u.code));
  if (missingUnits.length) await tx.unit.createMany({ data: missingUnits.map((u) => ({ id: uuidv7(), tenantId, ...u })) });

  const lists = await tx.priceList.findMany({ where: { tenantId }, select: { code: true } });
  const haveLists = new Set(lists.map((l) => l.code));
  const missingLists = DEFAULT_PRICE_LISTS.filter((l) => !haveLists.has(l.code));
  if (missingLists.length) await tx.priceList.createMany({ data: missingLists.map((l) => ({ id: uuidv7(), tenantId, ...l })) });
}
