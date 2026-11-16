import { Route } from '@angular/router';
import { authGuard, guestGuard, pairingGuard, permissionGuard, supportGuard, webOnlyGuard } from './core/http';

export const appRoutes: Route[] = [
  {
    path: 'ingresar',
    canActivate: [guestGuard],
    title: 'Ingresar · Vektra POS',
    loadComponent: () => import('./pages/login/login').then((m) => m.LoginPage),
  },
  {
    // Punto de venta a pantalla completa (sin menú lateral)
    path: 'pos',
    canActivate: [authGuard, permissionGuard('sales.create')],
    title: 'Caja · Vektra POS',
    loadComponent: () => import('./pages/pos/pos').then((m) => m.PosPage),
  },
  {
    // Caja de escritorio: vincular con el servidor de la empresa
    path: 'caja/vincular',
    canActivate: [pairingGuard],
    title: 'Vincular caja · Vektra POS',
    loadComponent: () => import('./pages/desktop/desktop-setup').then((m) => m.DesktopSetupPage),
  },
  {
    path: '',
    canActivate: [authGuard, webOnlyGuard],
    loadComponent: () => import('./layout/shell').then((m) => m.Shell),
    children: [
      { path: '', title: 'Inicio · Vektra POS', loadComponent: () => import('./pages/home/home').then((m) => m.HomePage) },
      {
        path: 'usuarios',
        title: 'Usuarios · Vektra POS',
        canActivate: [permissionGuard('users.read')],
        loadComponent: () => import('./pages/users/users').then((m) => m.UsersPage),
      },
      {
        path: 'roles',
        title: 'Roles y permisos · Vektra POS',
        canActivate: [permissionGuard('roles.read')],
        loadComponent: () => import('./pages/roles/roles').then((m) => m.RolesPage),
      },
      {
        path: 'establecimientos',
        title: 'Establecimientos · Vektra POS',
        canActivate: [permissionGuard('structure.read')],
        loadComponent: () => import('./pages/structure/structure').then((m) => m.StructurePage),
      },
      {
        path: 'cajas-escritorio',
        title: 'Cajas de escritorio · Vektra POS',
        canActivate: [permissionGuard('structure.read')],
        loadComponent: () => import('./pages/devices/devices').then((m) => m.DevicesPage),
      },
      {
        path: 'empresa',
        title: 'Empresa · Vektra POS',
        canActivate: [permissionGuard('company.read')],
        loadComponent: () => import('./pages/company/company').then((m) => m.CompanyPage),
      },
      {
        path: 'auditoria',
        title: 'Auditoría · Vektra POS',
        canActivate: [permissionGuard('audit.read')],
        loadComponent: () => import('./pages/audit/audit').then((m) => m.AuditPage),
      },
      {
        path: 'facturacion/nueva',
        title: 'Nueva factura · Vektra POS',
        canActivate: [permissionGuard('sales.create')],
        loadComponent: () => import('./pages/einvoice/new-invoice').then((m) => m.NewInvoicePage),
      },
      {
        path: 'facturacion/comprobantes',
        title: 'Comprobantes · Vektra POS',
        canActivate: [permissionGuard('einvoice.read')],
        loadComponent: () => import('./pages/einvoice/documents').then((m) => m.DocumentsPage),
      },
      {
        path: 'facturacion/comprobantes/:id',
        title: 'Comprobante · Vektra POS',
        canActivate: [permissionGuard('einvoice.read')],
        loadComponent: () => import('./pages/einvoice/document-detail').then((m) => m.DocumentDetailPage),
      },
      {
        path: 'facturacion/configuracion',
        title: 'Firma y correo · Vektra POS',
        canActivate: [permissionGuard('einvoice.read')],
        loadComponent: () => import('./pages/einvoice/einvoice-settings').then((m) => m.EInvoiceSettingsPage),
      },
      {
        path: 'impuestos',
        title: 'Impuestos · Vektra POS',
        canActivate: [permissionGuard('catalog.read')],
        loadComponent: () => import('./pages/einvoice/tax-rates').then((m) => m.TaxRatesPage),
      },
      {
        path: 'productos',
        title: 'Productos · Vektra POS',
        canActivate: [permissionGuard('catalog.read')],
        loadComponent: () => import('./pages/catalog/products').then((m) => m.ProductsPage),
      },
      {
        path: 'clientes',
        title: 'Clientes y proveedores · Vektra POS',
        canActivate: [permissionGuard('customers.read')],
        loadComponent: () => import('./pages/catalog/parties').then((m) => m.PartiesPage),
      },
      {
        path: 'inventario',
        title: 'Inventario · Vektra POS',
        canActivate: [permissionGuard('inventory.read')],
        loadComponent: () => import('./pages/inventory/stock').then((m) => m.StockPage),
      },
      {
        path: 'catalogos',
        title: 'Catálogos · Vektra POS',
        canActivate: [permissionGuard('catalog.read')],
        loadComponent: () => import('./pages/catalog/catalogs').then((m) => m.CatalogsPage),
      },
      {
        path: 'importar',
        title: 'Importar Excel · Vektra POS',
        canActivate: [permissionGuard('catalog.read')],
        loadComponent: () => import('./pages/catalog/import').then((m) => m.ImportPage),
      },
      { path: 'mi-cuenta', title: 'Mi cuenta · Vektra POS', loadComponent: () => import('./pages/account/account').then((m) => m.AccountPage) },
      {
        path: 'soporte/empresas',
        title: 'Empresas de la instalación · Vektra POS',
        canActivate: [supportGuard],
        loadComponent: () => import('./pages/support/tenants').then((m) => m.TenantsPage),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
