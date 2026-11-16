/**
 * Catálogo de permisos del sistema. Los códigos son estables (se guardan en BD);
 * las descripciones se muestran al administrador al editar roles.
 * Se siembra en la tabla `permission` en cada despliegue (seed idempotente).
 */
export interface PermissionDef {
  code: string;
  module: string;
  description: string;
}

export const PERMISSION_MODULES: Record<string, string> = {
  company: 'Empresa',
  users: 'Usuarios y roles',
  structure: 'Establecimientos y cajas',
  audit: 'Auditoría',
  license: 'Licencia',
  catalog: 'Productos',
  customers: 'Clientes',
  inventory: 'Inventario',
  sales: 'Ventas',
  cash: 'Caja',
  einvoice: 'Comprobantes electrónicos',
  purchases: 'Compras',
  receivables: 'Cuentas por cobrar',
  reports: 'Reportes',
  tax: 'Configuración tributaria',
};

export const PERMISSIONS = [
  { code: 'company.read', module: 'company', description: 'Ver datos de la empresa' },
  { code: 'company.update', module: 'company', description: 'Editar datos de la empresa, logo y módulos' },
  { code: 'users.read', module: 'users', description: 'Ver usuarios' },
  { code: 'users.manage', module: 'users', description: 'Crear, editar y desactivar usuarios' },
  { code: 'roles.read', module: 'users', description: 'Ver roles y permisos' },
  { code: 'roles.manage', module: 'users', description: 'Crear y editar roles y sus permisos' },
  { code: 'structure.read', module: 'structure', description: 'Ver establecimientos, puntos de emisión y bodegas' },
  { code: 'structure.manage', module: 'structure', description: 'Gestionar establecimientos, puntos de emisión y bodegas' },
  { code: 'audit.read', module: 'audit', description: 'Ver bitácora de auditoría' },
  { code: 'license.read', module: 'license', description: 'Ver estado de la licencia' },
  { code: 'license.manage', module: 'license', description: 'Ingresar códigos de activación' },
  { code: 'catalog.read', module: 'catalog', description: 'Ver productos y precios' },
  { code: 'catalog.manage', module: 'catalog', description: 'Crear y editar productos y precios' },
  { code: 'catalog.costs', module: 'catalog', description: 'Ver costos y utilidad' },
  { code: 'customers.read', module: 'customers', description: 'Ver clientes' },
  { code: 'customers.manage', module: 'customers', description: 'Crear y editar clientes' },
  { code: 'inventory.read', module: 'inventory', description: 'Ver stock y kárdex' },
  { code: 'inventory.adjust', module: 'inventory', description: 'Ajustes, conteos y transferencias de inventario' },
  { code: 'sales.create', module: 'sales', description: 'Vender y emitir facturas' },
  { code: 'sales.discount', module: 'sales', description: 'Aplicar descuentos' },
  { code: 'sales.void', module: 'sales', description: 'Anular ventas / emitir notas de crédito' },
  { code: 'sales.quote', module: 'sales', description: 'Crear proformas' },
  { code: 'cash.operate', module: 'cash', description: 'Abrir, cerrar caja y registrar movimientos' },
  { code: 'cash.supervise', module: 'cash', description: 'Ver cierres de todas las cajas' },
  { code: 'einvoice.read', module: 'einvoice', description: 'Ver comprobantes electrónicos' },
  { code: 'einvoice.resend', module: 'einvoice', description: 'Reenviar comprobantes al SRI y por correo' },
  { code: 'einvoice.certificate', module: 'einvoice', description: 'Gestionar firma electrónica' },
  { code: 'purchases.manage', module: 'purchases', description: 'Registrar compras y retenciones' },
  { code: 'receivables.manage', module: 'receivables', description: 'Registrar abonos y ver estados de cuenta' },
  { code: 'reports.read', module: 'reports', description: 'Ver reportes de ventas e inventario' },
  { code: 'reports.tax', module: 'reports', description: 'Reportes tributarios y ATS' },
  { code: 'tax.manage', module: 'tax', description: 'Configurar tarifas e impuestos' },
] as const satisfies readonly PermissionDef[];

export type PermissionCode = (typeof PERMISSIONS)[number]['code'];

export const ALL_PERMISSION_CODES: PermissionCode[] = PERMISSIONS.map((p) => p.code);

export interface SystemRoleDef {
  code: string;
  name: string;
  description: string;
  permissions: PermissionCode[] | 'ALL';
}

/** Roles que se crean automáticamente en cada empresa nueva (editables por el administrador). */
export const SYSTEM_ROLES: SystemRoleDef[] = [
  {
    code: 'ADMIN',
    name: 'Administrador',
    description: 'Acceso total a la empresa',
    permissions: 'ALL',
  },
  {
    code: 'ACCOUNTANT',
    name: 'Contador',
    description: 'Comprobantes, compras, retenciones y reportes tributarios',
    permissions: [
      'company.read', 'structure.read', 'catalog.read', 'catalog.costs', 'customers.read', 'customers.manage',
      'inventory.read', 'einvoice.read', 'einvoice.resend', 'purchases.manage', 'receivables.manage',
      'reports.read', 'reports.tax', 'tax.manage', 'cash.supervise', 'audit.read',
    ],
  },
  {
    code: 'WAREHOUSE',
    name: 'Bodeguero',
    description: 'Productos, stock, ajustes y transferencias',
    permissions: ['structure.read', 'catalog.read', 'catalog.manage', 'inventory.read', 'inventory.adjust', 'purchases.manage'],
  },
  {
    code: 'CASHIER',
    name: 'Cajero',
    description: 'Ventas en caja, cobros y cierre de caja',
    permissions: ['catalog.read', 'customers.read', 'customers.manage', 'inventory.read', 'sales.create', 'sales.quote', 'cash.operate', 'einvoice.read', 'receivables.manage'],
  },
  {
    code: 'SELLER',
    name: 'Vendedor',
    description: 'Proformas y pedidos; sin manejo de caja',
    permissions: ['catalog.read', 'customers.read', 'customers.manage', 'inventory.read', 'sales.quote'],
  },
];

export function resolveRolePermissions(role: SystemRoleDef): PermissionCode[] {
  return role.permissions === 'ALL' ? ALL_PERMISSION_CODES : role.permissions;
}
