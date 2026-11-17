import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { ActivatedRoute, Router } from '@angular/router';
import type { CatalogLookups, ReportCell, ReportColumn, ReportKind, ReportResult } from '@vektra/shared-contracts';
import { AuthService } from '../../core/auth.service';
import { Notify } from '../../core/notify.service';
import { CatalogApi } from '../catalog/catalog.api';
import { openBlob } from '../einvoice/einvoice.api';
import { localDate, REPORTS, ReportsApi } from './reports.api';

/** Reportes de gestión con rango de fechas y descarga a Excel. */
@Component({
  selector: 'vk-reports',
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatProgressBarModule],
  template: `
    <div class="vk-page">
      <div class="vk-page-header">
        <div>
          <h1>Reportes</h1>
          <p>Ventas, utilidad, inventario, compras, cartera e impuestos. Todos se descargan a Excel.</p>
        </div>
      </div>

      <div class="layout">
        <nav class="menu" aria-label="Reportes">
          @for (g of groups(); track g.name) {
            <span class="group">{{ g.name }}</span>
            @for (r of g.items; track r.kind) {
              <button type="button" class="item" [class.active]="r.kind === kind()" (click)="select(r.kind)">
                <span class="material-symbols-outlined" aria-hidden="true">{{ r.icon }}</span>{{ r.label }}
              </button>
            }
          }
        </nav>

        <section class="content">
          <mat-form-field class="picker">
            <mat-label>Reporte</mat-label>
            <mat-select [value]="kind()" (valueChange)="select($event)">
              @for (g of groups(); track g.name) {
                <mat-optgroup [label]="g.name">
                  @for (r of g.items; track r.kind) { <mat-option [value]="r.kind">{{ r.label }}</mat-option> }
                </mat-optgroup>
              }
            </mat-select>
          </mat-form-field>
          <div class="filters">
            @if (!def().snapshot) {
              <mat-form-field>
                <mat-label>Desde</mat-label>
                <input matInput type="date" [(ngModel)]="from" [max]="to" />
              </mat-form-field>
              <mat-form-field>
                <mat-label>Hasta</mat-label>
                <input matInput type="date" [(ngModel)]="to" [min]="from" />
              </mat-form-field>
              <div class="quick">
                <button matButton type="button" (click)="range('today')">Hoy</button>
                <button matButton type="button" (click)="range('month')">Este mes</button>
                <button matButton type="button" (click)="range('last')">Mes anterior</button>
              </div>
            }
            @if (def().warehouse) {
              <mat-form-field class="wh">
                <mat-label>Bodega</mat-label>
                <mat-select [(ngModel)]="warehouseId">
                  <mat-option [value]="null">Todas</mat-option>
                  @for (w of lookups()?.warehouses ?? []; track w.id) { <mat-option [value]="w.id">{{ w.name }} · {{ w.establishment }}</mat-option> }
                </mat-select>
              </mat-form-field>
            }
            <div class="actions">
              <button matButton="filled" type="button" (click)="load()" [disabled]="loading()"><span class="material-symbols-outlined">refresh</span> Generar</button>
              <button matButton="outlined" type="button" (click)="excel()" [disabled]="loading() || !result()"><span class="material-symbols-outlined">download</span> Excel</button>
            </div>
          </div>

          @if (loading()) { <mat-progress-bar mode="indeterminate" /> }

          @if (result(); as r) {
            <div class="head">
              <h2>{{ r.title }}</h2>
              <span class="vk-muted">{{ r.subtitle }} · {{ r.rows.length }} {{ r.rows.length === 1 ? 'fila' : 'filas' }}</span>
            </div>
            <div class="vk-table-wrap">
              <table class="tbl">
                <thead>
                  <tr>
                    @for (c of r.columns; track c.key) { <th [class.r]="numeric(c)">{{ c.label }}</th> }
                  </tr>
                </thead>
                <tbody>
                  @for (row of r.rows; track $index) {
                    <tr>
                      @for (c of r.columns; track c.key) { <td [class.r]="numeric(c)" [class.num]="numeric(c)" [class.neg]="negative(row[c.key])">{{ fmt(c, row[c.key]) }}</td> }
                    </tr>
                  } @empty {
                    <tr><td [attr.colspan]="r.columns.length" class="vk-muted empty">No hay datos en este período.</td></tr>
                  }
                </tbody>
                @if (r.totals && r.rows.length) {
                  <tfoot>
                    <tr>
                      @for (c of r.columns; track c.key) { <td [class.r]="numeric(c)" [class.num]="numeric(c)" [class.neg]="negative(r.totals[c.key])">{{ fmt(c, r.totals[c.key]) }}</td> }
                    </tr>
                  </tfoot>
                }
              </table>
            </div>
            @for (n of r.notes; track n) { <p class="note vk-muted">{{ n }}</p> }
          }
        </section>
      </div>
    </div>
  `,
  styles: `
    .layout { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 20px; align-items: start; }
    .menu { display: flex; flex-direction: column; gap: 2px; position: sticky; top: 12px; }
    .group { font: var(--mat-sys-label-medium); color: var(--vk-muted); text-transform: uppercase; letter-spacing: 0.04em; margin: 12px 0 4px 10px; }
    .group:first-child { margin-top: 0; }
    .item { display: flex; align-items: center; gap: 10px; border: 0; background: none; text-align: left; padding: 9px 10px; border-radius: 10px; font: var(--mat-sys-body-medium); color: inherit; cursor: pointer; }
    .item:hover { background: var(--mat-sys-surface-container); }
    .item.active { background: var(--mat-sys-secondary-container); color: var(--mat-sys-on-secondary-container); font-weight: 600; }
    .item:focus-visible { outline: 2px solid var(--mat-sys-primary); outline-offset: 1px; }
    .item .material-symbols-outlined { font-size: 20px; }
    .filters { display: flex; flex-wrap: wrap; gap: 0 12px; align-items: center; }
    .filters mat-form-field { width: 170px; }
    .filters .wh { width: 260px; }
    .quick { display: flex; gap: 2px; margin-bottom: 20px; }
    .actions { display: flex; gap: 8px; margin: 0 0 20px auto; }
    .head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin: 4px 0 10px; }
    h2 { font: var(--mat-sys-title-large); margin: 0; }
    .tbl { width: 100%; border-collapse: collapse; }
    .tbl th, .tbl td { padding: 8px 12px; border-bottom: 1px solid var(--mat-sys-outline-variant); text-align: left; }
    .tbl th { font: var(--mat-sys-label-medium); color: var(--vk-muted); white-space: nowrap; position: sticky; top: 0; background: var(--mat-sys-surface); }
    .tbl tfoot td { font-weight: 700; border-top: 2px solid var(--mat-sys-outline); border-bottom: 0; }
    .r { text-align: right !important; }
    .num { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .neg { color: var(--vk-danger); }
    .empty { padding: 24px 12px; }
    .note { margin: 8px 0 0; font-size: 13px; }
    .picker { display: none; width: 100%; }
    .content { min-width: 0; }
    @media (max-width: 900px) {
      .layout { grid-template-columns: minmax(0, 1fr); }
      .menu { display: none; }
      .picker { display: block; }
      .filters mat-form-field { width: calc(50% - 6px); }
      .filters .wh { width: 100%; }
      .actions { margin-left: 0; }
    }
  `,
})
export class ReportsPage implements OnInit {
  private readonly api = inject(ReportsApi);
  private readonly catalog = inject(CatalogApi);
  private readonly auth = inject(AuthService);
  private readonly notify = inject(Notify);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  private readonly available = REPORTS.filter((r) => this.auth.can(r.permission));
  protected readonly groups = computed(() => {
    const out: { name: string; items: typeof REPORTS }[] = [];
    for (const r of this.available) {
      const g = out.find((x) => x.name === r.group) ?? out[out.push({ name: r.group, items: [] }) - 1];
      g.items.push(r);
    }
    return out;
  });
  protected readonly kind = signal<ReportKind>(this.available[0]?.kind ?? 'sales_daily');
  protected readonly def = computed(() => REPORTS.find((r) => r.kind === this.kind()) ?? REPORTS[0]);
  protected readonly result = signal<ReportResult | null>(null);
  protected readonly loading = signal(false);
  protected readonly lookups = signal<CatalogLookups | null>(null);
  protected from = localDate().slice(0, 8) + '01';
  protected to = localDate();
  protected warehouseId: string | null = null;

  async ngOnInit(): Promise<void> {
    const wanted = this.route.snapshot.queryParamMap.get('r') as ReportKind | null;
    if (wanted && this.available.some((r) => r.kind === wanted)) this.kind.set(wanted);
    this.catalog.lookups().then((l) => this.lookups.set(l)).catch(() => undefined);
    await this.load();
  }

  protected async select(kind: ReportKind): Promise<void> {
    this.kind.set(kind);
    this.result.set(null);
    this.router.navigate([], { queryParams: { r: kind }, replaceUrl: true });
    await this.load();
  }

  protected range(which: 'today' | 'month' | 'last'): void {
    const today = localDate();
    if (which === 'today') {
      this.from = this.to = today;
    } else if (which === 'month') {
      this.from = today.slice(0, 8) + '01';
      this.to = today;
    } else {
      const [y, m] = today.split('-').map(Number);
      const first = new Date(Date.UTC(y, m - 2, 1));
      const last = new Date(Date.UTC(y, m - 1, 0));
      this.from = first.toISOString().slice(0, 10);
      this.to = last.toISOString().slice(0, 10);
    }
    void this.load();
  }

  private params() {
    return { kind: this.kind(), from: this.from, to: this.to, warehouseId: this.def().warehouse ? this.warehouseId : null };
  }

  protected async load(): Promise<void> {
    if (!this.from || !this.to) return this.notify.error('Elija el rango de fechas');
    this.loading.set(true);
    try {
      this.result.set(await this.api.run(this.params()));
    } catch (e) {
      this.notify.error(e);
    } finally {
      this.loading.set(false);
    }
  }

  protected async excel(): Promise<void> {
    this.loading.set(true);
    try {
      const p = this.params();
      openBlob(await this.api.excel(p), `${this.def().label} ${this.def().snapshot ? localDate() : `${p.from} a ${p.to}`}.xlsx`);
    } catch (e) {
      this.notify.error(e);
    } finally {
      this.loading.set(false);
    }
  }

  protected numeric(c: ReportColumn): boolean {
    return c.type === 'money' || c.type === 'number' || c.type === 'percent';
  }

  protected negative(v: ReportCell | undefined): boolean {
    return typeof v === 'number' && v < 0;
  }

  private readonly money = new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD' });
  private readonly number = new Intl.NumberFormat('es-EC', { maximumFractionDigits: 4 });

  protected fmt(c: ReportColumn, v: ReportCell | undefined): string {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'number') {
      if (c.type === 'money') return this.money.format(v);
      if (c.type === 'percent') return `${this.number.format(v)} %`;
      return this.number.format(v);
    }
    if (c.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v.split('-').reverse().join('/');
    return v;
  }
}
