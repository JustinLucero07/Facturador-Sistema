import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { LicenseStore } from '../../core/license.store';

interface Shortcut {
  link: string;
  icon: string;
  label: string;
  hint: string;
  permission: string;
}

const SHORTCUTS: Shortcut[] = [
  { link: '/pos', icon: 'point_of_sale', label: 'Vender', hint: 'Punto de venta con caja', permission: 'sales.create' },
  { link: '/facturacion/nueva', icon: 'add_notes', label: 'Nueva factura', hint: 'Factura con todos los datos', permission: 'sales.create' },
  { link: '/facturacion/comprobantes', icon: 'receipt_long', label: 'Comprobantes', hint: 'Estado en el SRI, RIDE y reenvío', permission: 'einvoice.read' },
  { link: '/compras/nueva', icon: 'local_shipping', label: 'Registrar compra', hint: 'Desde el XML del proveedor', permission: 'purchases.manage' },
  { link: '/cuentas/cobrar', icon: 'request_quote', label: 'Cobrar', hint: 'Cartera y abonos de clientes', permission: 'receivables.manage' },
  { link: '/reportes', icon: 'bar_chart', label: 'Reportes', hint: 'Ventas, utilidad e inventario', permission: 'reports.read' },
];

@Component({
  selector: 'vk-home',
  imports: [RouterLink],
  template: `
    <div class="vk-page">
      <div class="vk-page-header">
        <div>
          <h1>{{ greeting() }}, {{ firstName() }}</h1>
          <p>{{ auth.tenantName() }} · RUC <span class="vk-mono">{{ auth.session()?.tenant?.ruc }}</span></p>
        </div>
      </div>

      @if (shortcuts().length) {
        <nav class="shortcuts" aria-label="Accesos rápidos">
          @for (s of shortcuts(); track s.link) {
            <a [routerLink]="s.link" class="shortcut">
              <span class="material-symbols-outlined" aria-hidden="true">{{ s.icon }}</span>
              <span class="txt">
                <strong>{{ s.label }}</strong>
                <span>{{ s.hint }}</span>
              </span>
            </a>
          }
        </nav>
      }

      <div class="status">
        <section class="vk-card stat">
          <span class="material-symbols-outlined icon" aria-hidden="true">verified</span>
          <div>
            <div class="label">Licencia</div>
            @if (license.status(); as s) {
              <div class="value">
                @switch (s.state) {
                  @case ('valid') { <span class="vk-badge ok">{{ s.kind === 'perpetual' ? 'Permanente' : 'Activa' }}</span> }
                  @case ('missing') { <span class="vk-badge" [class.danger]="!s.canIssueDocuments">{{ s.canIssueDocuments ? 'Modo desarrollo' : 'Sin licencia' }}</span> }
                  @case ('suspended') { <span class="vk-badge danger">Suspendida</span> }
                  @case ('expired') { <span class="vk-badge danger">Vencida</span> }
                  @default { <span class="vk-badge danger">Inválida</span> }
                }
                @if (s.plan) { <span class="plan">{{ s.plan }}</span> }
              </div>
              <div class="hint">{{ s.canIssueDocuments ? 'Puede emitir comprobantes' : s.message }}</div>
            } @else {
              <div class="hint">Cargando…</div>
            }
          </div>
        </section>

        <section class="vk-card stat">
          <span class="material-symbols-outlined icon" aria-hidden="true">cloud_sync</span>
          <div>
            <div class="label">Ambiente del SRI</div>
            <div class="value">
              @if (auth.session()?.tenant?.environment === 2) {
                <span class="vk-badge ok">Producción</span>
              } @else {
                <span class="vk-badge warn">Pruebas</span>
              }
            </div>
            <div class="hint">
              @if (auth.session()?.tenant?.environment === 2) { Sus comprobantes tienen validez tributaria } @else { Los comprobantes aún no tienen validez tributaria }
            </div>
          </div>
        </section>

        <section class="vk-card stat">
          <span class="material-symbols-outlined icon" aria-hidden="true">extension</span>
          <div>
            <div class="label">Módulos activos</div>
            <div class="value">{{ auth.session()?.tenant?.modules?.length ?? 0 }}</div>
            <div class="hint">Se activan en Empresa</div>
          </div>
        </section>
      </div>

      @if (auth.can('company.update')) {
        <section class="vk-card steps">
          <h2>Para empezar a facturar</h2>
          <ol>
            <li>Revise los <a routerLink="/empresa">datos de la empresa</a> tal como constan en el RUC.</li>
            <li>Suba su <a routerLink="/facturacion/configuracion">firma electrónica (.p12) y el correo</a> de envío.</li>
            <li>Configure sus <a routerLink="/establecimientos">establecimientos y puntos de emisión</a> igual que en el SRI.</li>
            <li>Cargue sus <a routerLink="/productos">productos</a> (o <a routerLink="/importar">impórtelos desde Excel</a>) y cree los <a routerLink="/usuarios">usuarios</a> de su equipo.</li>
            <li>Pruebe en ambiente de pruebas y, cuando todo se autorice, cambie a producción en <a routerLink="/empresa">Empresa</a>.</li>
          </ol>
        </section>
      }
    </div>
  `,
  styles: `
    .shortcuts {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 12px;
      margin-bottom: 24px;
    }
    .shortcut {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 16px 18px;
      background: #fff;
      border: 1px solid var(--vk-line);
      border-radius: var(--vk-radius);
      text-decoration: none;
      color: var(--vk-ink);
      transition: border-color 120ms ease, background-color 120ms ease;

      .material-symbols-outlined {
        font-size: 24px;
        color: var(--mat-sys-primary);
        background: var(--mat-sys-primary-container);
        border-radius: 10px;
        padding: 9px;
      }
      &:hover {
        border-color: var(--mat-sys-primary);
      }
    }
    .txt {
      display: flex;
      flex-direction: column;
      min-width: 0;

      strong {
        font-size: 15.5px;
        font-weight: 600;
      }
      span {
        font-size: 13px;
        color: var(--vk-muted);
      }
    }
    .status {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 12px;
      margin-bottom: 24px;
    }
    .stat {
      display: flex;
      gap: 14px;
      align-items: flex-start;
      padding: 18px 20px;
    }
    .icon {
      font-size: 22px;
      color: var(--vk-muted);
      background: var(--mat-sys-surface-container-low);
      border-radius: 10px;
      padding: 8px;
    }
    .label {
      font-size: 13.5px;
      font-weight: 500;
      color: var(--vk-muted);
    }
    .value {
      font-size: 22px;
      font-weight: 600;
      margin: 4px 0 2px;
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .plan {
      font-size: 16px;
      font-weight: 500;
      text-transform: capitalize;
    }
    .hint {
      font-size: 13px;
      color: var(--vk-muted);
    }
    @media (max-width: 599px) {
      .shortcuts {
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }
      .shortcut {
        flex-direction: column;
        align-items: flex-start;
        gap: 10px;
        padding: 14px;
      }
      .txt span {
        display: none;
      }
    }
    .steps ol {
      margin: 0;
      padding-left: 22px;
      max-width: 80ch;
    }
    .steps li {
      margin: 8px 0;
      padding-left: 4px;
    }
  `,
})
export class HomePage {
  protected readonly auth = inject(AuthService);
  protected readonly license = inject(LicenseStore);
  protected readonly shortcuts = computed(() => SHORTCUTS.filter((s) => this.auth.can(s.permission)));
  protected readonly firstName = computed(() => this.auth.session()?.user.fullName.split(' ')[0] ?? '');
  protected readonly greeting = computed(() => {
    const h = new Date().getHours();
    return h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches';
  });
}
