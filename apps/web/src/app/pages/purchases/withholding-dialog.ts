import { CurrencyPipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import type { EInvoiceConfig, WithholdingCodeItem, WithholdingDraft, WithholdingRequest } from '@vektra/shared-contracts';
import { firstValueFrom } from 'rxjs';
import { apiMessage } from '../../core/http';
import { Notify } from '../../core/notify.service';

interface Item {
  key: number;
  tax: '1' | '2';
  codeId: string;
  query: string;
  base: string;
  percentage: string;
}

let seq = 0;
const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

/**
 * Comprobante de retención sobre una compra. Los códigos y porcentajes vienen del catálogo (BD):
 * renta del Catálogo ATS, IVA de la Tabla 20 de la Ficha. Se sugiere lo último retenido al proveedor.
 */
@Component({
  selector: 'vk-withholding-dialog',
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatCheckboxModule, MatAutocompleteModule, CurrencyPipe],
  template: `
    <h2 mat-dialog-title>Comprobante de retención</h2>
    <mat-dialog-content class="c">
      @if (draft(); as d) {
        <p class="head">
          <strong>{{ d.purchase.supplier.name }}</strong> · {{ d.purchase.supplier.identification }}<br />
          <span class="vk-muted">Factura {{ d.purchase.number }} del {{ d.purchase.issueDate }} · subtotal {{ d.purchase.subtotal | currency }} · IVA {{ d.purchase.iva | currency }} · total {{ d.purchase.total | currency }}</span>
        </p>
        @if (d.previous) { <div class="hint">Se cargaron los códigos de la última retención a este proveedor. Revíselos antes de emitir.</div> }

        <div class="grid">
          <mat-form-field>
            <mat-label>Punto de emisión</mat-label>
            <mat-select [(ngModel)]="emissionPointId">
              @for (p of points(); track p.id) { <mat-option [value]="p.id">{{ p.label }}</mat-option> }
            </mat-select>
          </mat-form-field>
          <mat-form-field>
            <mat-label>Forma de pago de la compra</mat-label>
            <mat-select [(ngModel)]="paymentCode">
              @for (p of payments(); track p.code) { <mat-option [value]="p.code">{{ p.code }} · {{ p.description }}</mat-option> }
            </mat-select>
          </mat-form-field>
          <mat-form-field class="span">
            <mat-label>Sustento tributario (Tabla 5 del ATS)</mat-label>
            <mat-select [(ngModel)]="sustentoCode">
              @for (s of d.sustento; track s.code) { <mat-option [value]="s.code">{{ s.code }} · {{ s.description }}</mat-option> }
            </mat-select>
          </mat-form-field>
        </div>
        <mat-checkbox [(ngModel)]="relatedParty">El proveedor es parte relacionada</mat-checkbox>

        <h3>Retenciones</h3>
        @for (it of items(); track it.key; let k = $index) {
          <div class="item">
            <span class="tax">{{ it.tax === '1' ? 'Renta' : 'IVA' }}</span>
            <mat-form-field class="code">
              <mat-label>Código</mat-label>
              <input matInput [(ngModel)]="it.query" (ngModelChange)="touch()" [matAutocomplete]="ac" placeholder="Código o descripción" />
              <mat-autocomplete #ac="matAutocomplete" (optionSelected)="pick(k, $event.option.value)" class="wide-ac">
                @for (c of options(it); track c.id) {
                  <mat-option [value]="c.id">
                    <strong>{{ c.code }}</strong> · {{ c.percentage !== null ? (+c.percentage + '%') : 'variable' }} · <small>{{ c.description }}</small>
                  </mat-option>
                }
              </mat-autocomplete>
              @if (codeOf(it)?.percentageNote) { <mat-hint>{{ codeOf(it)?.percentageNote }}</mat-hint> }
            </mat-form-field>
            <mat-form-field class="num">
              <mat-label>Base</mat-label>
              <input matInput [(ngModel)]="it.base" (ngModelChange)="touch()" inputmode="decimal" />
            </mat-form-field>
            <mat-form-field class="num">
              <mat-label>%</mat-label>
              <input matInput [(ngModel)]="it.percentage" (ngModelChange)="touch()" [readonly]="codeOf(it)?.percentage !== null && !!codeOf(it)" inputmode="decimal" />
            </mat-form-field>
            <span class="amt">{{ amount(it) | currency }}</span>
            <button matIconButton (click)="remove(k)" aria-label="Quitar"><span class="material-symbols-outlined">close</span></button>
          </div>
        }
        <div class="add">
          <button matButton="outlined" (click)="add('1')"><span class="material-symbols-outlined">add</span> Retención de renta</button>
          <button matButton="outlined" (click)="add('2')" [disabled]="!(+d.purchase.iva > 0)"><span class="material-symbols-outlined">add</span> Retención de IVA</button>
        </div>
        <div class="total"><span>Total retenido</span><strong>{{ total() | currency }}</strong></div>
      } @else {
        <p class="vk-muted">Cargando…</p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancelar</button>
      <button matButton="filled" (click)="save()" [disabled]="busy() || !items().length">{{ busy() ? 'Emitiendo…' : 'Emitir retención' }}</button>
    </mat-dialog-actions>
  `,
  styles: `
    .c { width: min(820px, 88vw); }
    .head { margin: 0 0 12px; }
    .hint { background: var(--vk-warn-bg); color: var(--vk-warn); padding: 8px 12px; border-radius: 10px; margin-bottom: 12px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
    .span { grid-column: 1 / -1; }
    h3 { font: var(--mat-sys-title-small); margin: 16px 0 8px; }
    .item { display: grid; grid-template-columns: 52px minmax(0, 1fr) 110px 80px 90px 40px; gap: 8px; align-items: center; }
    .tax { font: var(--mat-sys-label-large); color: var(--mat-sys-primary); }
    .amt { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; padding-bottom: 20px; }
    .add { display: flex; gap: 8px; flex-wrap: wrap; margin: 4px 0 12px; }
    .total { display: flex; justify-content: space-between; font: 600 18px/1.4 inherit; font-family: inherit; border-top: 1px solid var(--mat-sys-outline-variant); padding-top: 10px; }
    @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } .item { grid-template-columns: 1fr 1fr; } .tax, .code { grid-column: 1 / -1; } }
  `,
})
export class WithholdingDialog implements OnInit {
  protected readonly data = inject<{ purchaseId: string }>(MAT_DIALOG_DATA);
  private readonly http = inject(HttpClient);
  private readonly notify = inject(Notify);
  private readonly ref = inject(MatDialogRef<WithholdingDialog, { documentId: string; number: string; total: string }>);
  protected readonly draft = signal<WithholdingDraft | null>(null);
  protected readonly codes = signal<WithholdingCodeItem[]>([]);
  protected readonly points = signal<EInvoiceConfig['emissionPoints']>([]);
  protected readonly payments = signal<EInvoiceConfig['paymentMethods']>([]);
  protected readonly items = signal<Item[]>([]);
  protected readonly busy = signal(false);
  private readonly version = signal(0);
  protected emissionPointId = '';
  protected sustentoCode = '';
  protected paymentCode = '';
  protected relatedParty = false;

  protected readonly total = computed(() => {
    this.version();
    return round2(this.items().reduce((a, it) => a + Number(this.amount(it)), 0)).toFixed(2);
  });

  async ngOnInit(): Promise<void> {
    try {
      const [d, codes, cfg] = await Promise.all([
        firstValueFrom(this.http.get<WithholdingDraft>(`/api/einvoice/purchases/${this.data.purchaseId}/withholding-draft`)),
        firstValueFrom(this.http.get<WithholdingCodeItem[]>('/api/tax/withholding-codes')),
        firstValueFrom(this.http.get<EInvoiceConfig>('/api/einvoice/config')),
      ]);
      this.codes.set(codes.filter((c) => c.active && c.residence === 'RESIDENT' && (c.tax === '1' || c.tax === '2')));
      this.points.set(cfg.emissionPoints);
      this.payments.set(cfg.paymentMethods);
      this.emissionPointId = cfg.emissionPoints[0]?.id ?? '';
      this.draft.set(d);
      if (d.previous) {
        this.sustentoCode = d.previous.sustentoCode;
        this.paymentCode = d.previous.paymentCode ?? '';
        this.relatedParty = d.previous.relatedParty ?? false;
        for (const p of d.previous.items) {
          const c = this.codes().find((x) => x.id === p.withholdingCodeId);
          if (c) this.items.update((ls) => [...ls, this.newItem(c.tax as '1' | '2', c, c.percentage === null ? p.percentage : c.percentage)]);
        }
      }
    } catch (e) {
      this.notify.error(apiMessage(e));
    }
  }

  private newItem(tax: '1' | '2', c: WithholdingCodeItem | null, percentage = ''): Item {
    const d = this.draft();
    return {
      key: ++seq,
      tax,
      codeId: c?.id ?? '',
      query: c ? `${c.code} · ${c.description}` : '',
      base: tax === '1' ? (d?.purchase.subtotal ?? '0') : (d?.purchase.iva ?? '0'),
      percentage: c?.percentage ?? percentage,
    };
  }

  protected touch(): void {
    this.version.update((v) => v + 1);
  }

  protected codeOf(it: Item): WithholdingCodeItem | undefined {
    return this.codes().find((c) => c.id === it.codeId);
  }

  protected options(it: Item): WithholdingCodeItem[] {
    this.version();
    const q = it.query.trim().toLowerCase();
    const list = this.codes().filter((c) => c.tax === it.tax);
    if (!q || this.codeOf(it)) return list.slice(0, 40);
    return list.filter((c) => c.code.toLowerCase().startsWith(q) || c.description.toLowerCase().includes(q)).slice(0, 40);
  }

  protected pick(k: number, id: string): void {
    const c = this.codes().find((x) => x.id === id);
    if (!c) return;
    this.items.update((ls) => ls.map((it, i) => (i === k ? { ...it, codeId: c.id, query: `${c.code} · ${c.description}`, percentage: c.percentage ?? '' } : it)));
  }

  protected add(tax: '1' | '2'): void {
    this.items.update((ls) => [...ls, this.newItem(tax, null)]);
  }

  protected remove(k: number): void {
    this.items.update((ls) => ls.filter((_, i) => i !== k));
  }

  protected amount(it: Item): string {
    const v = round2((Number(it.base || 0) * Number(it.percentage || 0)) / 100);
    return Number.isFinite(v) ? v.toFixed(2) : '0.00';
  }

  protected async save(): Promise<void> {
    if (!this.sustentoCode) return this.notify.error('Elija el sustento tributario');
    if (!this.paymentCode) return this.notify.error('Elija la forma de pago de la compra');
    const missing = this.items().find((it) => !it.codeId);
    if (missing) return this.notify.error('Elija el código de cada retención');
    const body: WithholdingRequest = {
      purchaseId: this.data.purchaseId,
      emissionPointId: this.emissionPointId,
      sustentoCode: this.sustentoCode,
      paymentCode: this.paymentCode,
      relatedParty: this.relatedParty,
      items: this.items().map((it) => ({
        withholdingCodeId: it.codeId,
        base: it.base,
        percentage: this.codeOf(it)?.percentage === null ? it.percentage : null,
      })),
    };
    this.busy.set(true);
    try {
      this.ref.close(await firstValueFrom(this.http.post<{ documentId: string; number: string; total: string }>('/api/einvoice/withholdings', body)));
    } catch (e) {
      this.notify.error(apiMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
