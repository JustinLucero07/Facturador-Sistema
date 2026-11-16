import { JsonPipe } from '@angular/common';
import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import type { TaxRateItem } from '@vektra/shared-contracts';
import { AuthService } from '../../core/auth.service';
import { Notify } from '../../core/notify.service';
import { EInvoiceApi } from './einvoice.api';

/** Tarifas de IVA y parámetros del SRI. Cambiar una tarifa afecta solo a las ventas nuevas. */
@Component({
  selector: 'vk-tax-rates',
  imports: [FormsModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatSlideToggleModule, JsonPipe],
  template: `
    <div class="vk-page">
      <div class="vk-page-header">
        <div>
          <h1>Impuestos y parámetros SRI</h1>
          <p>Tarifas según la Tabla 17 de la Ficha Técnica del SRI. Los cambios aplican a las ventas nuevas; las ya emitidas conservan su IVA.</p>
        </div>
      </div>

      <div class="vk-table-wrap">
        <table class="simple">
          <thead>
            <tr><th>Código SRI</th><th>Nombre</th><th>Etiqueta (RIDE)</th><th class="r">Tarifa %</th><th>Activa</th><th></th></tr>
          </thead>
          <tbody>
            @for (r of rates(); track r.id) {
              <tr [class.off]="!r.active">
                <td class="vk-mono">{{ r.taxCode }} / {{ r.percentageCode }}</td>
                <td><input class="cell" [(ngModel)]="r.name" [disabled]="!canEdit" /></td>
                <td><input class="cell" [(ngModel)]="r.label" [disabled]="!canEdit" /></td>
                <td class="r"><input class="cell num" [(ngModel)]="r.rate" [disabled]="!canEdit" inputmode="decimal" /></td>
                <td><mat-slide-toggle [(ngModel)]="r.active" [disabled]="!canEdit" /></td>
                <td>@if (canEdit) { <button matButton (click)="save(r)">Guardar</button> }</td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      <h2>Parámetros</h2>
      <div class="vk-table-wrap">
        <table class="simple">
          <thead><tr><th>Parámetro</th><th>Valor</th><th>Fuente / nota</th></tr></thead>
          <tbody>
            @for (s of settings(); track s.key) {
              <tr>
                <td class="vk-mono">{{ s.key }}</td>
                <td>
                  @if (s.key === 'final_consumer' && canEdit) {
                    Monto máximo consumidor final: $
                    <input class="cell num" [ngModel]="$any(s.value).maxAmount" (ngModelChange)="$any(s.value).maxAmount = $event" />
                    <button matButton (click)="saveSetting(s.key, s.value)">Guardar</button>
                  } @else {
                    <code class="val">{{ s.value | json }}</code>
                    @if (s.supportOnly) { <span class="vk-badge">Solo Soporte Vektra</span> }
                  }
                </td>
                <td class="vk-muted small">{{ s.note }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </div>
  `,
  styles: `
    h2 { font: var(--mat-sys-title-medium); margin: 24px 0 12px; }
    .simple { border-collapse: collapse; width: 100%; }
    .simple th, .simple td { padding: 8px 10px; border-bottom: 1px solid var(--mat-sys-outline-variant); text-align: left; vertical-align: middle; }
    .simple th { font: var(--mat-sys-label-medium); color: var(--vk-muted); }
    .r { text-align: right; }
    .cell { width: 100%; min-width: 80px; border: 1px solid transparent; background: transparent; padding: 6px 8px; border-radius: 6px; font: inherit; color: inherit; }
    .cell:enabled:hover, .cell:focus { border-color: var(--mat-sys-outline); outline: none; background: var(--mat-sys-surface); }
    .num { text-align: right; width: 90px; min-width: 0; }
    .off td { opacity: 0.55; }
    .val { font-size: 12px; word-break: break-all; }
    .small { font: var(--mat-sys-body-small); }
  `,
})
export class TaxRatesPage implements OnInit {
  private readonly api = inject(EInvoiceApi);
  private readonly notify = inject(Notify);
  private readonly auth = inject(AuthService);
  protected readonly canEdit = this.auth.can('tax.manage');
  protected readonly rates = signal<TaxRateItem[]>([]);
  protected readonly settings = signal<{ key: string; value: unknown; note: string | null; supportOnly: boolean }[]>([]);

  async ngOnInit(): Promise<void> {
    try {
      this.rates.set(await this.api.taxRates());
      if (this.canEdit) this.settings.set(await this.api.settings());
    } catch (e) {
      this.notify.error(e);
    }
  }

  protected async save(r: TaxRateItem): Promise<void> {
    try {
      await this.api.updateTaxRate(r.id, { ...r, taxCode: r.taxCode as '2' | '3' | '5', rate: String(r.rate).replace(',', '.') });
      this.notify.ok(`Tarifa ${r.name} guardada. Aplica a las ventas nuevas.`);
    } catch (e) {
      this.notify.error(e);
    }
  }

  protected async saveSetting(key: string, value: unknown): Promise<void> {
    try {
      await this.api.updateSetting(key, value);
      this.notify.ok('Parámetro guardado');
    } catch (e) {
      this.notify.error(e);
    }
  }
}
