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

/** Planes y límites. 0 = ilimitado. Los cambios llegan a las instalaciones en su próxima validación. */
@Component({
  selector: 'hub-plans',
  imports: [FormsModule, MatFormFieldModule, MatInputModule, MatButtonModule, CurrencyPipe],
  template: `
    <div class="vk-page">
      <div class="vk-page-header">
        <div>
          <h1>Planes</h1>
          <p>Límites por plan (0 = ilimitado). Se aplican en las instalaciones en máximo 1 hora.</p>
        </div>
      </div>
      <div class="plans">
        @for (p of plans(); track p.id) {
          <section class="vk-card">
            <div class="head">
              <h2>{{ p.name }}</h2>
              <span class="vk-muted">{{ p.installationCount }} instalaciones</span>
            </div>
            <mat-form-field class="w">
              <mat-label>Precio mensual (USD)</mat-label>
              <input matInput type="number" min="0" step="0.01" [(ngModel)]="p.priceMonthly" />
              <mat-hint>{{ p.priceMonthly | currency }}</mat-hint>
            </mat-form-field>
            @for (l of limits; track l.key) {
              <mat-form-field class="w">
                <mat-label>{{ l.label }}</mat-label>
                <input matInput type="number" min="0" [ngModel]="p.limits[l.key]" (ngModelChange)="setLimit(p, l.key, $event)" />
              </mat-form-field>
            }
            <div class="mods">
              <div class="vk-muted">Módulos incluidos</div>
              <label><input type="checkbox" [checked]="p.limits.modules.includes('*')" (change)="toggleModule(p, '*')" /> Todos</label>
              @if (!p.limits.modules.includes('*')) {
                @for (m of modules; track m[0]) {
                  <label><input type="checkbox" [checked]="p.limits.modules.includes(m[0])" (change)="toggleModule(p, m[0])" /> {{ m[1].name }}</label>
                }
              }
            </div>
            <div class="vk-actions"><button matButton="filled" (click)="save(p)">Guardar</button></div>
          </section>
        }
      </div>
    </div>
  `,
  styles: `
    .plans { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; align-items: start; }
    .head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
    h2 { font: var(--mat-sys-title-large); margin: 0; }
    .w { width: 100%; }
    .mods { display: flex; flex-direction: column; gap: 6px; margin: 12px 0; }
    label { display: flex; gap: 8px; align-items: center; }
  `,
})
export class PlansPage implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly toast = inject(Toast);
  protected readonly plans = signal<PlanItem[]>([]);
  protected readonly limits = LIMITS;
  protected readonly modules = Object.entries(MODULES);

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
      await firstValueFrom(this.http.patch(`/api/hub/plans/${id}`, { ...body, priceMonthly: Number(body.priceMonthly) }));
      this.toast.ok(`Plan ${p.name} guardado`);
    } catch (e) {
      this.toast.error(e);
    }
  }
}
