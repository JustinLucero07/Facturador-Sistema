import { CurrencyPipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { RouterLink } from '@angular/router';
import type { AtsPreview } from '@vektra/shared-contracts';
import { Notify } from '../../core/notify.service';
import { openBlob } from '../einvoice/einvoice.api';
import { localDate, ReportsApi } from './reports.api';

const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

/** Anexo Transaccional Simplificado: revisión previa y archivo para el DIMM / SRI en línea. */
@Component({
  selector: 'vk-ats',
  imports: [FormsModule, MatButtonModule, MatCheckboxModule, MatFormFieldModule, MatSelectModule, MatProgressBarModule, RouterLink, CurrencyPipe],
  template: `
    <div class="vk-page">
      <div class="vk-page-header">
        <div>
          <h1>Anexo Transaccional (ATS)</h1>
          <p>Genera el ATS desde sus compras, ventas y retenciones. Revise los avisos antes de cargarlo en el DIMM o en SRI en línea.</p>
        </div>
      </div>

      <div class="filters">
        <mat-form-field>
          <mat-label>Año</mat-label>
          <mat-select [(ngModel)]="year" (ngModelChange)="clear()">
            @for (y of years; track y) { <mat-option [value]="y">{{ y }}</mat-option> }
          </mat-select>
        </mat-form-field>
        @if (!semiannual) {
          <mat-form-field>
            <mat-label>Mes</mat-label>
            <mat-select [(ngModel)]="month" (ngModelChange)="clear()">
              @for (m of months; track $index) { <mat-option [value]="$index + 1">{{ m }}</mat-option> }
            </mat-select>
          </mat-form-field>
        } @else {
          <mat-form-field>
            <mat-label>Semestre</mat-label>
            <mat-select [(ngModel)]="month" (ngModelChange)="clear()">
              <mat-option [value]="6">Primer semestre (enero – junio)</mat-option>
              <mat-option [value]="12">Segundo semestre (julio – diciembre)</mat-option>
            </mat-select>
          </mat-form-field>
        }
        <mat-checkbox [(ngModel)]="semiannual" (ngModelChange)="toggleSemiannual()">Semestral (régimen RIMPE)</mat-checkbox>
        <button matButton="filled" type="button" (click)="review()" [disabled]="loading()"><span class="material-symbols-outlined">fact_check</span> Revisar</button>
      </div>

      @if (loading()) { <mat-progress-bar mode="indeterminate" /> }

      @if (p(); as p) {
        <section class="status" [class.ok]="p.valid" [class.bad]="!p.valid" role="status">
          <span class="material-symbols-outlined" aria-hidden="true">{{ p.valid ? 'task_alt' : 'error' }}</span>
          <div>
            <strong>{{ p.valid ? 'El anexo está listo' : 'El anexo tiene errores' }}</strong>
            <span>{{ period() }} · {{ p.fileName }} · {{ errors().length }} {{ errors().length === 1 ? 'error' : 'errores' }}, {{ warnings().length }} {{ warnings().length === 1 ? 'aviso' : 'avisos' }}</span>
          </div>
          <div class="dl">
            <button matButton="filled" type="button" [disabled]="!p.valid || loading()" (click)="download('xml')"><span class="material-symbols-outlined">download</span> XML para el DIMM</button>
            <button matButton="outlined" type="button" [disabled]="!p.valid || loading()" (click)="download('zip')"><span class="material-symbols-outlined">folder_zip</span> {{ p.fileName }}.zip</button>
          </div>
        </section>

        @if (p.issues.length || p.xsdErrors.length) {
          <ul class="issues">
            @for (i of p.issues; track $index) {
              <li [class]="i.level">
                <span class="material-symbols-outlined" aria-hidden="true">{{ i.level === 'error' ? 'cancel' : 'warning' }}</span>
                <span class="msg">{{ i.message }}</span>
                @if (i.link) { <a [routerLink]="path(i.link)" [queryParams]="query(i.link)">Corregir</a> }
              </li>
            }
            @for (e of p.xsdErrors; track $index) {
              <li class="error"><span class="material-symbols-outlined" aria-hidden="true">code</span><span class="msg">Esquema del SRI: {{ e }}</span></li>
            }
          </ul>
        }

        <div class="cards">
          <div class="card">
            <span class="lbl">Compras</span>
            <strong>{{ p.purchases.count }}</strong>
            <dl>
              <dt>Bases</dt><dd>{{ p.purchases.base | currency }}</dd>
              <dt>IVA</dt><dd>{{ p.purchases.iva | currency }}</dd>
              <dt>Retención IVA</dt><dd>{{ p.purchases.ivaWithheld | currency }}</dd>
              <dt>Retención renta</dt><dd>{{ p.purchases.rentaWithheld | currency }}</dd>
            </dl>
          </div>
          <div class="card">
            <span class="lbl">Ventas</span>
            <strong>{{ p.sales.documents }}</strong>
            <dl>
              <dt>Bases</dt><dd>{{ p.sales.base | currency }}</dd>
              <dt>IVA</dt><dd>{{ p.sales.iva | currency }}</dd>
              <dt>Notas de crédito ({{ p.creditNotes.documents }})</dt><dd>−{{ p.creditNotes.base | currency }}</dd>
              <dt>Le retuvieron IVA</dt><dd>{{ p.sales.ivaWithheld | currency }}</dd>
              <dt>Le retuvieron renta</dt><dd>{{ p.sales.rentaWithheld | currency }}</dd>
            </dl>
          </div>
          <div class="card">
            <span class="lbl">Total ventas del anexo</span>
            <strong>{{ p.totalSales | currency }}</strong>
            <dl>
              <dt>Establecimientos</dt><dd>{{ p.establishmentsCount }}</dd>
              @for (e of p.salesByEstablishment; track e.code) { <dt>Establecimiento {{ e.code }}</dt><dd>{{ e.total | currency }}</dd> }
              <dt>Filas de clientes</dt><dd>{{ p.sales.rows }}</dd>
            </dl>
          </div>
        </div>

        <p class="note vk-muted">
          Incluye las compras registradas en el período (fecha de registro = día en que se ingresaron al sistema) y los comprobantes de venta autorizados por el SRI.
          @if (p.options.includeElectronicSales) { Las facturas electrónicas se detallan por cliente con tipo de emisión «E». } @else { Solo se detallan los clientes con retenciones recibidas. }
          Pagos al exterior, reembolsos y exportaciones no se generan desde el sistema. Antes de presentar, valide el archivo en el DIMM del SRI.
        </p>
      }
    </div>
  `,
  styles: `
    .filters { display: flex; flex-wrap: wrap; gap: 0 12px; align-items: center; }
    .filters mat-form-field { width: 220px; }
    .filters mat-checkbox, .filters button { margin-bottom: 20px; }
    .status { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; padding: 16px 18px; border-radius: 14px; margin: 8px 0 16px; border: 1px solid; }
    .status > .material-symbols-outlined { font-size: 32px; }
    .status div:not(.dl) { display: flex; flex-direction: column; }
    .status strong { font: var(--mat-sys-title-medium); }
    .status.ok { background: color-mix(in srgb, var(--vk-success) 10%, transparent); border-color: color-mix(in srgb, var(--vk-success) 40%, transparent); }
    .status.ok > .material-symbols-outlined { color: var(--vk-success); }
    .status.bad { background: color-mix(in srgb, var(--vk-danger) 8%, transparent); border-color: color-mix(in srgb, var(--vk-danger) 35%, transparent); }
    .status.bad > .material-symbols-outlined { color: var(--vk-danger); }
    .dl { display: flex; gap: 8px; flex-wrap: wrap; margin-left: auto; }
    .issues { list-style: none; margin: 0 0 16px; padding: 0; border: 1px solid var(--mat-sys-outline-variant); border-radius: 14px; overflow: hidden; }
    .issues li { display: flex; align-items: flex-start; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--mat-sys-outline-variant); }
    .issues li:first-child { border-top: 0; }
    .issues .error .material-symbols-outlined { color: var(--vk-danger); }
    .issues .warning .material-symbols-outlined { color: var(--vk-warning, #b26a00); }
    .issues .msg { flex: 1; }
    .issues a { color: var(--mat-sys-primary); white-space: nowrap; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
    .card { padding: 16px; border-radius: 14px; background: var(--mat-sys-surface); border: 1px solid var(--mat-sys-outline-variant); display: flex; flex-direction: column; gap: 4px; }
    .card strong { font: 700 26px/1.2 var(--mat-sys-body-large-font); font-variant-numeric: tabular-nums; }
    .lbl { font: var(--mat-sys-label-medium); color: var(--vk-muted); text-transform: uppercase; letter-spacing: 0.04em; }
    dl { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; margin: 8px 0 0; }
    dt { color: var(--vk-muted); }
    dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
    .note { margin-top: 16px; font-size: 13px; max-width: 900px; }
  `,
})
export class AtsPage {
  private readonly api = inject(ReportsApi);
  private readonly notify = inject(Notify);
  protected readonly months = MONTHS;
  private readonly today = localDate();
  protected readonly years = Array.from({ length: 4 }, (_, i) => Number(this.today.slice(0, 4)) - i);
  // Por defecto el mes anterior (el ATS se presenta el mes siguiente)
  protected year = Number(this.today.slice(5, 7)) === 1 ? Number(this.today.slice(0, 4)) - 1 : Number(this.today.slice(0, 4));
  protected month = Number(this.today.slice(5, 7)) === 1 ? 12 : Number(this.today.slice(5, 7)) - 1;
  protected semiannual = false;
  protected readonly p = signal<AtsPreview | null>(null);
  protected readonly loading = signal(false);
  protected readonly errors = computed(() => [...(this.p()?.issues.filter((i) => i.level === 'error') ?? []), ...(this.p()?.xsdErrors ?? [])]);
  protected readonly warnings = computed(() => this.p()?.issues.filter((i) => i.level === 'warning') ?? []);
  protected readonly period = computed(() => {
    const p = this.p();
    if (!p) return '';
    return p.semiannual ? `${p.month === 6 ? 'Primer' : 'Segundo'} semestre ${p.year}` : `${MONTHS[p.month - 1]} ${p.year}`;
  });

  protected clear(): void {
    this.p.set(null);
  }

  protected toggleSemiannual(): void {
    if (this.semiannual) this.month = this.month <= 6 ? 6 : 12;
    this.clear();
  }

  protected async review(): Promise<void> {
    this.loading.set(true);
    try {
      this.p.set(await this.api.ats(this.year, this.month, this.semiannual));
    } catch (e) {
      this.notify.error(e);
    } finally {
      this.loading.set(false);
    }
  }

  protected async download(format: 'xml' | 'zip'): Promise<void> {
    const p = this.p();
    if (!p) return;
    this.loading.set(true);
    try {
      openBlob(await this.api.atsFile(p.year, p.month, p.semiannual, format), `${p.fileName}.${format}`);
    } catch {
      this.notify.error('No se pudo generar el archivo: vuelva a revisar el anexo.');
      await this.review();
    } finally {
      this.loading.set(false);
    }
  }

  protected path(link: string): string {
    return link.split('?')[0];
  }

  protected query(link: string): Record<string, string> | null {
    const q = link.split('?')[1];
    return q ? Object.fromEntries(new URLSearchParams(q)) : null;
  }
}
