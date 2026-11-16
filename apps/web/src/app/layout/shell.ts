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
    title: 'Administración',
    items: [
      { label: 'Empresa', icon: 'storefront', link: '/empresa', permission: 'company.read' },
      { label: 'Establecimientos', icon: 'store', link: '/establecimientos', permission: 'structure.read' },
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
