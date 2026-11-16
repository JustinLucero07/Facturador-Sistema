import { DatePipe } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { LicenseStore } from '../../core/license.store';

@Component({
  selector: 'vk-home',
  imports: [RouterLink, DatePipe],
  template: `
    <div class="vk-page">
      <div class="vk-page-header">
        <div>
          <h1>{{ greeting() }}, {{ firstName() }}</h1>
          <p>{{ auth.tenantName() }} · RUC <span class="vk-mono">{{ auth.session()?.tenant?.ruc }}</span></p>
        </div>
      </div>

      <div class="grid">
        <section class="vk-card stat">
          <span class="material-symbols-outlined icon">verified</span>
          <div>
            <div class="label">Licencia</div>
            @if (license.status(); as s) {
              <div class="value">
                @switch (s.state) {
                  @case ('valid') { <span class="vk-badge ok">Activa</span> }
                  @case ('missing') { <span class="vk-badge" [class.danger]="!s.canIssueDocuments">{{ s.canIssueDocuments ? 'Modo desarrollo' : 'Sin licencia' }}</span> }
                  @case ('suspended') { <span class="vk-badge danger">Suspendida</span> }
                  @case ('expired') { <span class="vk-badge danger">Vencida</span> }
                  @default { <span class="vk-badge danger">Inválida</span> }
                }
                @if (s.plan) { <span class="vk-muted">Plan {{ s.plan }}</span> }
              </div>
              @if (s.lastValidatedAt) {
                <div class="hint">Última validación: {{ s.lastValidatedAt | date: 'short' }}</div>
              }
            } @else {
              <div class="hint">Cargando…</div>
            }
          </div>
        </section>

        <section class="vk-card stat">
          <span class="material-symbols-outlined icon">cloud_sync</span>
          <div>
            <div class="label">Ambiente SRI</div>
            <div class="value">
              @if (auth.session()?.tenant?.environment === 2) {
                <span class="vk-badge ok">Producción</span>
              } @else {
                <span class="vk-badge warn">Pruebas</span>
              }
            </div>
            <div class="hint">Se configura en Empresa</div>
          </div>
        </section>

        <section class="vk-card stat">
          <span class="material-symbols-outlined icon">extension</span>
          <div>
            <div class="label">Módulos activos</div>
            <div class="value">{{ auth.session()?.tenant?.modules?.length ?? 0 }}</div>
            <div class="hint">Según el tipo de negocio y su plan</div>
          </div>
        </section>
      </div>

      <section class="vk-card next">
        <h2>Primeros pasos</h2>
        <ol>
          <li>
            Revise los <a routerLink="/empresa">datos de la empresa</a> tal como constan en el RUC (razón social, dirección matriz, régimen).
          </li>
          <li>Configure sus <a routerLink="/establecimientos">establecimientos y puntos de emisión</a> igual que en el SRI.</li>
          <li>Cree los <a routerLink="/usuarios">usuarios</a> de su equipo y asígneles un rol.</li>
          <li>Active la verificación en dos pasos en <a routerLink="/mi-cuenta">Mi cuenta</a>.</li>
        </ol>
        <p class="vk-muted">Próximamente: firma electrónica y facturación SRI, productos, inventario y punto de venta.</p>
      </section>
    </div>
  `,
  styles: `
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 16px;
      margin-bottom: 16px;
    }
    .stat {
      display: flex;
      gap: 16px;
      align-items: flex-start;
    }
    .icon {
      font-size: 28px;
      color: var(--mat-sys-primary);
      background: var(--mat-sys-primary-container);
      border-radius: 10px;
      padding: 8px;
    }
    .label {
      font: var(--mat-sys-label-large);
      color: var(--vk-muted);
    }
    .value {
      font: var(--mat-sys-title-large);
      margin: 6px 0 4px;
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .hint {
      font: var(--mat-sys-body-small);
      color: var(--vk-muted);
    }
    .next h2 {
      font: var(--mat-sys-title-medium);
      margin: 0 0 8px;
    }
    .next li {
      margin: 6px 0;
    }
    a {
      color: var(--mat-sys-primary);
    }
  `,
})
export class HomePage {
  protected readonly auth = inject(AuthService);
  protected readonly license = inject(LicenseStore);
  protected readonly firstName = computed(() => this.auth.session()?.user.fullName.split(' ')[0] ?? '');
  protected readonly greeting = computed(() => {
    const h = new Date().getHours();
    return h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches';
  });
}
