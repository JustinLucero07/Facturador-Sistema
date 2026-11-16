import { Route } from '@angular/router';
import { hubAuthGuard } from './hub';

export const appRoutes: Route[] = [
  { path: 'ingresar', title: 'Ingresar · Vektra Hub', loadComponent: () => import('./pages/login').then((m) => m.HubLogin) },
  {
    path: '',
    canActivate: [hubAuthGuard],
    loadComponent: () => import('./pages/shell').then((m) => m.HubShell),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'instalaciones' },
      { path: 'instalaciones', title: 'Instalaciones · Vektra Hub', loadComponent: () => import('./pages/installations').then((m) => m.InstallationsPage) },
      { path: 'clientes', title: 'Clientes · Vektra Hub', loadComponent: () => import('./pages/clients').then((m) => m.ClientsPage) },
      { path: 'planes', title: 'Planes · Vektra Hub', loadComponent: () => import('./pages/plans').then((m) => m.PlansPage) },
    ],
  },
  { path: '**', redirectTo: '' },
];
