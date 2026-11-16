/**
 * Módulos activables por empresa y plantillas por tipo de negocio.
 * La plantilla solo define el estado INICIAL; el administrador puede cambiarlo luego.
 */
export const MODULES = {
  variants: { name: 'Variantes (talla/color)', description: 'Ropa, calzado' },
  lots: { name: 'Lotes y caducidad', description: 'Farmacia, minimarket' },
  serials: { name: 'Números de serie y garantía', description: 'Tecnología, repuestos' },
  fractional: { name: 'Venta fraccionada por medida', description: 'Metros, kilos, litros' },
  presale: { name: 'Preventa / vendedores en ruta', description: 'Distribuidoras' },
  receivables: { name: 'Cuentas por cobrar', description: 'Ventas a crédito con abonos' },
  multibranch: { name: 'Multisucursal', description: 'Varios establecimientos y transferencias' },
} as const;

export type ModuleCode = keyof typeof MODULES;

export interface BusinessTemplate {
  code: string;
  name: string;
  modules: ModuleCode[];
  /** Ajustes iniciales de la empresa (tenant.settings). */
  settings: { allowNegativeStock: boolean; quantityDecimals: number };
}

export const BUSINESS_TEMPLATES: BusinessTemplate[] = [
  { code: 'general', name: 'Negocio general', modules: ['receivables'], settings: { allowNegativeStock: true, quantityDecimals: 2 } },
  { code: 'hardware', name: 'Ferretería', modules: ['fractional', 'receivables'], settings: { allowNegativeStock: true, quantityDecimals: 3 } },
  { code: 'bazaar', name: 'Bazar / papelería', modules: ['receivables'], settings: { allowNegativeStock: true, quantityDecimals: 0 } },
  { code: 'distributor', name: 'Distribuidora', modules: ['presale', 'receivables', 'lots'], settings: { allowNegativeStock: false, quantityDecimals: 2 } },
  { code: 'minimarket', name: 'Minimarket / licorería', modules: ['lots', 'fractional'], settings: { allowNegativeStock: true, quantityDecimals: 3 } },
  { code: 'clothing', name: 'Ropa y calzado', modules: ['variants'], settings: { allowNegativeStock: false, quantityDecimals: 0 } },
  { code: 'pharmacy', name: 'Farmacia', modules: ['lots'], settings: { allowNegativeStock: false, quantityDecimals: 0 } },
  { code: 'autoparts', name: 'Repuestos / tecnología', modules: ['serials', 'receivables'], settings: { allowNegativeStock: false, quantityDecimals: 0 } },
];

export function findBusinessTemplate(code: string): BusinessTemplate {
  return BUSINESS_TEMPLATES.find((t) => t.code === code) ?? BUSINESS_TEMPLATES[0];
}
