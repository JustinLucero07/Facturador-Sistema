import { BreakpointObserver } from '@angular/cdk/layout';
import { Component, computed, inject, OnDestroy, OnInit } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatMenuModule } from '@angular/material/menu';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import type { TenantOption } from '@vektra/shared-contracts';
import { map } from 'rxjs';
import { AuthService } from '../core/auth.service';
import { LicenseStore } from '../core/license.store';
import { Notify } from '../core/notify.service';

interface NavItem {
  label: string;
  icon: string;
  link: string;
  permission?: string;
  support?: boolean;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

const NAV: NavSection[] = [
  { title: '', items: [{ label: 'Inicio', icon: 'space_dashboard', link: '/' }] },
  {
    title: 'Facturación',
    items: [
      { label: 'Punto de venta', icon: 'point_of_sale', link: '/pos', permission: 'sales.create' },
      { label: 'Nueva factura', icon: 'add_notes', link: '/facturacion/nueva', permission: 'sales.create' },
      { label: 'Comprobantes', icon: 'receipt_long', link: '/facturacion/comprobantes', permission: 'einvoice.read' },
      { label: 'Firma y correo', icon: 'key', link: '/facturacion/configuracion', permission: 'einvoice.read' },
      { label: 'Impuestos', icon: 'percent', link: '/impuestos', permission: 'catalog.read' },
      { label: 'Códigos de retención', icon: 'receipt', link: '/retenciones', permission: 'purchases.manage' },
    ],
  },
  {
    title: 'Inventario',
    items: [
      { label: 'Productos', icon: 'inventory_2', link: '/productos', permission: 'catalog.read' },
      { label: 'Clientes y proveedores', icon: 'contacts', link: '/clientes', permission: 'customers.read' },
      { label: 'Existencias y kárdex', icon: 'warehouse', link: '/inventario', permission: 'inventory.read' },
      { label: 'Compras', icon: 'local_shipping', link: '/compras', permission: 'purchases.manage' },
      { label: 'Catálogos', icon: 'category', link: '/catalogos', permission: 'catalog.read' },
      { label: 'Importar Excel', icon: 'upload_file', link: '/importar', permission: 'catalog.read' },
    ],
  },
  {
    title: 'Cuentas',
    items: [
      { label: 'Por cobrar', icon: 'request_quote', link: '/cuentas/cobrar', permission: 'receivables.manage' },
      { label: 'Por pagar', icon: 'account_balance_wallet', link: '/cuentas/pagar', permission: 'purchases.manage' },
    ],
  },
  {
    title: 'Reportes',
    items: [
      { label: 'Reportes', icon: 'bar_chart', link: '/reportes', permission: 'reports.read' },
      { label: 'ATS', icon: 'description', link: '/ats', permission: 'reports.tax' },
    ],
  },
  {
    title: 'Administración',
    items: [
      { label: 'Empresa', icon: 'storefront', link: '/empresa', permission: 'company.read' },
      { label: 'Establecimientos', icon: 'store', link: '/establecimientos', permission: 'structure.read' },
      { label: 'Cajas de escritorio', icon: 'desktop_windows', link: '/cajas-escritorio', permission: 'structure.read' },
      { label: 'Usuarios', icon: 'group', link: '/usuarios', permission: 'users.read' },
      { label: 'Roles y permisos', icon: 'admin_panel_settings', link: '/roles', permission: 'roles.read' },
      { label: 'Auditoría', icon: 'history', link: '/auditoria', permission: 'audit.read' },
    ],
  },
  {
    title: 'Soporte Vektra',
    items: [{ label: 'Empresas', icon: 'domain_add', link: '/soporte/empresas', support: true }],
  },
];

@Component({
  selector: 'vk-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatSidenavModule, MatButtonModule, MatMenuModule, MatDividerModule, MatTooltipModule],
  templateUrl: './shell.html',
  styleUrl: './shell.scss',
})
export class Shell implements OnInit, OnDestroy {
  protected readonly version = '1.0';
  protected readonly auth = inject(AuthService);
  protected readonly license = inject(LicenseStore);
  private readonly notify = inject(Notify);
  private timer: ReturnType<typeof setInterval> | undefined;

  protected readonly isMobile = toSignal(inject(BreakpointObserver).observe('(max-width: 959px)').pipe(map((r) => r.matches)), {
    initialValue: false,
  });

  protected readonly nav = computed(() => {
    const session = this.auth.session();
    const perms = this.auth.permissions();
    return NAV.map((s) => ({
      ...s,
      items: s.items.filter((i) => (i.support ? !!session?.user.isSupport : !i.permission || perms.has(i.permission))),
    })).filter((s) => s.items.length > 0);
  });

  protected readonly otherTenants = computed(() => {
    const s = this.auth.session();
    return s ? s.tenants.filter((t) => t.id !== s.tenant.id) : [];
  });

  protected readonly initials = computed(() =>
    (this.auth.session()?.user.fullName ?? '?')
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join(''),
  );

  ngOnInit(): void {
    void this.license.load();
    this.timer = setInterval(() => void this.license.load(), 5 * 60_000);
  }

  ngOnDestroy(): void {
    clearInterval(this.timer);
  }

  protected async switchTo(tenant: TenantOption): Promise<void> {
    try {
      await this.auth.switchTenant(tenant);
      void this.license.load();
      this.notify.ok(`Ahora trabaja en ${tenant.name}`);
    } catch (e) {
      this.notify.error(e);
    }
  }
}
