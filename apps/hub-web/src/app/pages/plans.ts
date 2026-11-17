import { CurrencyPipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import type { PlanItem } from '@vektra/shared-contracts';
import { MODULES } from '@vektra/shared-domain';
import { firstValueFrom } from 'rxjs';
import { Toast } from '../hub';

const LIMITS: { key: keyof PlanItem['limits']; label: string }[] = [
  { key: 'maxTenants', label: 'Empresas (RUC)' },
  { key: 'maxEstablishments', label: 'Establecimientos' },
  { key: 'maxEmissionPoints', label: 'Cajas / puntos de emisión' },
  { key: 'maxUsers', label: 'Usuarios' },
  { key: 'maxDocumentsPerMonth', label: 'Comprobantes por mes' },
];

/**
 * Licencias que vende Vektra (pago único). Cada una fija sus límites (0 = sin límite) y precios.
 * Los campos del contrato se conservan: priceMonthly = precio de la licencia; priceYearly = soporte anual opcional.
 */
@Component({
  selector: 'hub-plans',
  imports: [FormsModule, MatFormFieldModule, MatInputModule, MatButtonModule, CurrencyPipe],
  template: `
    <div class="vk-page">
      <div class="vk-page-header">
        <div>
          <h1>Licencias</h1>
          <p>Lo que vende: cada licencia es permanente (pago único) y define cuántas empresas, cajas y usuarios incluye.</p>
        </div>
        @if (!creating()) {
          <button matButton="filled" type="button" (click)="creating.set(true)"><span class="material-symbols-outlined">add</span> Nueva licencia</button>
        }
      </div>

      @if (creating()) {
        <form class="vk-card create" (ngSubmit)="create()">
          <h2>Nueva licencia permanente</h2>
          <div class="fields">
            <mat-form-field>
              <mat-label>Nombre</mat-label>
              <input matInput name="name" [(ngModel)]="draft.name" placeholder="Ej.: Ferretería completa" required />
            </mat-form-field>
            <mat-form-field>
              <mat-label>Precio de la licencia</mat-label>
              <span matTextPrefix>$&nbsp;</span>
              <input matInput name="price" type="number" min="0" step="0.01" [(ngModel)]="draft.price" required />
            </mat-form-field>
            <mat-form-field>
              <mat-label>Soporte por año (opcional)</mat-label>
              <span matTextPrefix>$&nbsp;</span>
              <input matInput name="support" type="number" min="0" step="0.01" [(ngModel)]="draft.support" />
            </mat-form-field>
          </div>
          <p class="vk-muted hint">Se crea con 1 empresa, 1 establecimiento, 2 cajas, 3 usuarios y todos los módulos; luego ajuste lo que incluye.</p>
          <div class="vk-actions">
            <button matButton type="button" (click)="creating.set(false)">Cancelar</button>
            <button matButton="filled" type="submit">Crear licencia</button>
          </div>
        </form>
      }
      <div class="plans">
        @for (p of plans(); track p.id) {
          <section class="plan">
            <header>
              <div>
                <h2>{{ p.name }}</h2>
                <span class="perm"><span class="material-symbols-outlined" aria-hidden="true">all_inclusive</span> Permanente · no vence</span>
                <span class="vk-muted">{{ p.installationCount }} {{ p.installationCount === 1 ? 'cliente la usa' : 'clientes la usan' }}</span>
              </div>
              <div class="price">
                <strong>{{ p.priceMonthly | currency }}</strong>
                <span>pago único</span>
              </div>
            </header>

            <div class="body">
              <h3>Precios</h3>
              <div class="two">
                <mat-form-field>
                  <mat-label>Precio de la licencia</mat-label>
                  <span matTextPrefix>$&nbsp;</span>
                  <input matInput type="number" min="0" step="0.01" [(ngModel)]="p.priceMonthly" />
                </mat-form-field>
                <mat-form-field>
                  <mat-label>Soporte por año</mat-label>
                  <span matTextPrefix>$&nbsp;</span>
                  <input matInput type="number" min="0" step="0.01" [(ngModel)]="p.priceYearly" />
                  <mat-hint>Opcional: actualizaciones y soporte</mat-hint>
                </mat-form-field>
              </div>

              <h3>Incluye <span class="vk-muted">· 0 = sin límite</span></h3>
              <div class="two">
                @for (l of limits; track l.key) {
                  <mat-form-field>
                    <mat-label>{{ l.label }}</mat-label>
                    <input matInput type="number" min="0" [ngModel]="p.limits[l.key]" (ngModelChange)="setLimit(p, l.key, $event)" />
                  </mat-form-field>
                }
              </div>

              <h3>Módulos</h3>
              <div class="mods">
                <label class="chip" [class.on]="p.limits.modules.includes('*')">
                  <input type="checkbox" [checked]="p.limits.modules.includes('*')" (change)="toggleModule(p, '*')" /> Todos
                </label>
                @if (!p.limits.modules.includes('*')) {
                  @for (m of modules; track m[0]) {
                    <label class="chip" [class.on]="p.limits.modules.includes(m[0])">
                      <input type="checkbox" [checked]="p.limits.modules.includes(m[0])" (change)="toggleModule(p, m[0])" /> {{ m[1].name }}
                    </label>
                  }
                }
              </div>
            </div>

            <footer>
              <span class="vk-muted note">Los cambios se aplican con el próximo código de activación del cliente.</span>
              <button matButton="filled" (click)="save(p)">Guardar</button>
            </footer>
          </section>
        }
      </div>
    </div>
  `,
  styles: `
    .create { margin-bottom: 20px; }
    .create .fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0 16px; align-items: start; }
    .hint { margin: 0 0 12px; font-size: 13.5px; }
    .perm { display: inline-flex; align-items: center; gap: 4px; margin: 2px 0 6px; padding: 2px 10px 2px 8px; border-radius: 999px; background: var(--vk-amber-bg); color: #7a4d06; font-size: 12.5px; font-weight: 600; }
    .perm .material-symbols-outlined { font-size: 16px; }
    .plans { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 20px; align-items: start; }
    .plan { background: #fff; border: 1px solid var(--vk-line); border-radius: var(--vk-radius); overflow: hidden; }
    header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding: 22px 24px 18px; border-bottom: 1px solid var(--vk-line); }
    h2 { font-size: 20px; font-weight: 600; margin: 0 0 2px; letter-spacing: -0.01em; }
    .price { text-align: right; display: flex; flex-direction: column; }
    .price strong { font-size: 26px; font-weight: 600; color: var(--mat-sys-primary); font-variant-numeric: tabular-nums; line-height: 1.1; }
    .price span { font-size: 12.5px; color: var(--vk-muted); }
    .body { padding: 18px 24px 4px; }
    h3 { font-size: 14px; font-weight: 600; margin: 6px 0 12px; color: var(--vk-ink); }
    h3 .vk-muted { font-weight: 400; }
    .two { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; align-items: start; }
    header > div:first-child { display: flex; flex-direction: column; align-items: flex-start; }
    .mods { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 18px; }
    .chip { display: inline-flex; gap: 6px; align-items: center; padding: 6px 12px; border: 1px solid var(--vk-line); border-radius: 999px; font-size: 13.5px; cursor: pointer; }
    .chip.on { background: var(--mat-sys-primary-container); border-color: transparent; color: var(--mat-sys-on-primary-container); font-weight: 600; }
    .chip input { accent-color: var(--mat-sys-primary); margin: 0; }
    footer { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 24px; background: var(--mat-sys-surface-container-low); border-top: 1px solid var(--vk-line); }
    .note { font-size: 13px; }
    @media (max-width: 480px) { .two { grid-template-columns: 1fr; } }
  `,
})
export class PlansPage implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly toast = inject(Toast);
  protected readonly plans = signal<PlanItem[]>([]);
  protected readonly limits = LIMITS;
  protected readonly modules = Object.entries(MODULES);
  protected readonly creating = signal(false);
  protected draft: { name: string; price: number | null; support: number | null } = { name: '', price: null, support: null };

  /** Código interno a partir del nombre (minúsculas, sin tildes). */
  private code(name: string): string {
    const base = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'licencia';
    return this.plans().some((p) => p.code === base) ? `${base}-${Date.now().toString(36).slice(-4)}` : base;
  }

  protected async create(): Promise<void> {
    const name = this.draft.name.trim();
    if (name.length < 2) return this.toast.error('Escriba el nombre de la licencia');
    if (this.draft.price === null || Number(this.draft.price) < 0) return this.toast.error('Escriba el precio de la licencia');
    try {
      await firstValueFrom(
        this.http.post('/api/hub/plans', {
          code: this.code(name),
          name,
          priceMonthly: Number(this.draft.price),
          priceYearly: this.draft.support === null || String(this.draft.support) === '' ? null : Number(this.draft.support),
          limits: { maxTenants: 1, maxEstablishments: 1, maxEmissionPoints: 2, maxUsers: 3, maxDocumentsPerMonth: 0, modules: ['*'] },
          active: true,
        }),
      );
      this.toast.ok(`Licencia ${name} creada`);
      this.draft = { name: '', price: null, support: null };
      this.creating.set(false);
      this.plans.set(await firstValueFrom(this.http.get<PlanItem[]>('/api/hub/plans')));
    } catch (e) {
      this.toast.error(e);
    }
  }

  async ngOnInit(): Promise<void> {
    this.plans.set(await firstValueFrom(this.http.get<PlanItem[]>('/api/hub/plans')));
  }

  protected setLimit(p: PlanItem, key: keyof PlanItem['limits'], value: number): void {
    (p.limits as unknown as Record<string, number>)[key] = Number(value) || 0;
  }

  protected toggleModule(p: PlanItem, code: string): void {
    const set = new Set(p.limits.modules);
    if (set.has(code)) set.delete(code);
    else set.add(code);
    p.limits.modules = [...set];
    this.plans.set([...this.plans()]);
  }

  protected async save(p: PlanItem): Promise<void> {
    const { id, installationCount: _c, ...body } = p;
    try {
      const yearly = body.priceYearly === null || body.priceYearly === undefined || String(body.priceYearly) === '' ? null : Number(body.priceYearly);
      await firstValueFrom(this.http.patch(`/api/hub/plans/${id}`, { ...body, priceMonthly: Number(body.priceMonthly), priceYearly: yearly }));
      this.toast.ok(`Licencia ${p.name} guardada`);
    } catch (e) {
      this.toast.error(e);
    }
  }
}
