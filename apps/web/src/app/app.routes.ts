import { Route } from '@angular/router';
import { authGuard, guestGuard, permissionGuard, supportGuard } from './core/http';

export const appRoutes: Route[] = [
  {
    path: 'ingresar',
    canActivate: [guestGuard],
    title: 'Ingresar · Vektra POS',
    loadComponent: () => import('./pages/login/login').then((m) => m.LoginPage),
  },
  {
    path: '',
    canActivate: [authGuard],
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
