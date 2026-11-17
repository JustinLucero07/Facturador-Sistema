import { CurrencyPipe, DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import type { CreditableInvoice, CreditNoteRequest, PaymentMethodDef } from '@vektra/shared-contracts';
import { computeInvoice, creditLine } from '@vektra/sri-core/calc';
import { firstValueFrom } from 'rxjs';
import { apiMessage } from '../../core/http';
import { Notify } from '../../core/notify.service';
import { CatalogApi } from '../catalog/catalog.api';

export interface ReturnDialogData {
  /** Factura ya elegida (desde el detalle del comprobante); si no, se busca por número */
  invoiceId?: string | null;
  emissionPointId: string;
  /** Caja abierta: el reembolso en efectivo sale de ella */
  cashSessionId?: string | null;
  methods: PaymentMethodDef[];
}

/** Medios de reembolso: los del POS; "crédito" se muestra como descuento de la deuda o saldo a favor. */
export function refundMethods(methods: PaymentMethodDef[]): PaymentMethodDef[] {
  return methods.map((m) => (m.credit ? { ...m, label: 'Descontar de la deuda / saldo a favor' } : m));
}

export interface ReturnResult {
  documentId: string;
  number: string;
  total: string;
}

const REASONS = ['Devolución de mercadería', 'Producto defectuoso', 'Error en la facturación', 'Anulación de la venta'];

/**
 * Devolución: nota de crédito total o parcial de una factura. Muestra lo que queda por devolver
 * en cada línea y calcula el total con la misma regla del servidor (precio e IVA de la factura).
 */
@Component({
  selector: 'vk-return-dialog',
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatCheckboxModule, CurrencyPipe, DatePipe],
  template: `
    <h2 mat-dialog-title>Devolución · nota de crédito</h2>
    <mat-dialog-content class="c">
      @if (!inv()) {
        <p class="vk-muted">Escriba el número de la factura (está en el ticket) o la clave de acceso.</p>
        <mat-form-field class="w">
          <mat-label>Factura N.º o clave de acceso</mat-label>
          <input matInput [(ngModel)]="query" (keydown.enter)="find()" placeholder="001-001-000000123" autocomplete="off" cdkFocusInitial />
        </mat-form-field>
      } @else {
        @let i = inv()!;
        <div class="head">
          <div><strong>Factura {{ i.number }}</strong> · {{ i.issueDate | date: 'mediumDate' : 'UTC' }}</div>
          <div class="vk-muted">{{ i.buyer.name }} · {{ i.buyer.id }} · total {{ i.total | currency }}@if (+i.credited > 0) { · ya devuelto {{ i.credited | currency }} }</div>
        </div>
        @if (i.status === 'NOT_AUTHORIZED' || i.status === 'RETURNED') {
          <div class="err">El SRI no autorizó esta factura: no se puede emitir nota de crédito.</div>
        }

        <div class="lines">
          <div class="row hdr"><span>Producto</span><span class="n">Vendido</span><span class="n">Devuelto</span><span class="n">Devolver</span><span>Stock</span></div>
          @for (l of i.lines; track l.id; let k = $index) {
            <div class="row" [class.done]="+l.remaining <= 0">
              <span class="desc">{{ l.description }}<small class="vk-muted"> · {{ l.taxLabel }}</small></span>
              <span class="n">{{ +l.quantity }}</span>
              <span class="n">{{ +l.credited }}</span>
              <span class="n qty">
                @if (+l.remaining > 0) {
                  <input type="number" min="0" [max]="+l.remaining" step="any" [ngModel]="qty()[k]" (ngModelChange)="setQty(k, $event)" [attr.aria-label]="'Cantidad a devolver de ' + l.description" />
                  <button type="button" matButton (click)="setQty(k, l.remaining)">Todo</button>
                } @else {
                  <span class="vk-muted">—</span>
                }
              </span>
              <span>
                @if (l.productId && +l.remaining > 0) {
                  <mat-checkbox [ngModel]="restock()[k]" (ngModelChange)="setRestock(k, $event)" aria-label="Vuelve al stock (desmarque si está dañado)" />
                }
              </span>
            </div>
          }
          <button type="button" matButton class="all" (click)="all()">Devolver todo lo que queda</button>
        </div>

        <div class="grid">
          <mat-form-field>
            <mat-label>Motivo</mat-label>
            <mat-select [(ngModel)]="reasonPick">
              @for (r of reasons; track r) { <mat-option [value]="r">{{ r }}</mat-option> }
              <mat-option value="otro">Otro…</mat-option>
            </mat-select>
          </mat-form-field>
          @if (reasonPick === 'otro') {
            <mat-form-field>
              <mat-label>Describa el motivo</mat-label>
              <input matInput [(ngModel)]="reasonText" maxlength="300" />
            </mat-form-field>
          }
          <mat-form-field>
            <mat-label>Reembolso</mat-label>
            <mat-select [(ngModel)]="method">
              @for (m of data.methods; track m.method) { <mat-option [value]="m.method">{{ m.label }}</mat-option> }
            </mat-select>
            @if (isCash() && data.cashSessionId) { <mat-hint>Se registra como egreso de la caja abierta</mat-hint> }
          </mat-form-field>
        </div>

        @if (i.buyer.idType === '07') {
          <p class="note">La venta fue a <strong>consumidor final</strong>. El SRI exige identificar al cliente en la nota de crédito.</p>
          <div class="grid">
            <mat-form-field>
              <mat-label>Tipo</mat-label>
              <mat-select [(ngModel)]="buyer.idType">
                <mat-option value="05">Cédula</mat-option>
                <mat-option value="04">RUC</mat-option>
                <mat-option value="06">Pasaporte</mat-option>
              </mat-select>
            </mat-form-field>
            <mat-form-field>
              <mat-label>Identificación</mat-label>
              <input matInput [(ngModel)]="buyer.id" (blur)="lookup()" inputmode="numeric" maxlength="20" />
            </mat-form-field>
            <mat-form-field class="span">
              <mat-label>Nombre o razón social</mat-label>
              <input matInput [(ngModel)]="buyer.name" maxlength="300" />
            </mat-form-field>
            <mat-form-field class="span">
              <mat-label>Correo (opcional)</mat-label>
              <input matInput [(ngModel)]="buyer.email" maxlength="300" inputmode="email" />
            </mat-form-field>
          </div>
        }

        <div class="total">
          <span>Total de la nota de crédito</span>
          <strong>{{ total() | currency }}</strong>
        </div>
        @if (calcError()) { <div class="err">{{ calcError() }}</div> }
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancelar</button>
      @if (!inv()) {
        <button matButton="filled" (click)="find()" [disabled]="busy()">Buscar</button>
      } @else {
        <button matButton="filled" (click)="save()" [disabled]="busy() || !(+total() > 0)">{{ busy() ? 'Emitiendo…' : 'Emitir nota de crédito' }}</button>
      }
    </mat-dialog-actions>
  `,
  styles: `
    .c { width: min(760px, 86vw); }
    .w { width: 100%; }
    .head { margin-bottom: 12px; }
    .lines { border: 1px solid var(--mat-sys-outline-variant); border-radius: 12px; padding: 4px 8px 8px; margin-bottom: 16px; }
    .row { display: grid; grid-template-columns: minmax(0, 1fr) 64px 70px 150px 48px; gap: 8px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--mat-sys-outline-variant); }
    .row.hdr { font: var(--mat-sys-label-medium); color: var(--vk-muted); }
    .row.done { opacity: 0.55; }
    .n { text-align: right; font-variant-numeric: tabular-nums; }
    .qty { display: flex; gap: 4px; align-items: center; justify-content: flex-end; }
    .qty input { width: 64px; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--mat-sys-outline); font: inherit; text-align: right; background: var(--mat-sys-surface); color: inherit; }
    .desc { overflow: hidden; text-overflow: ellipsis; }
    .all { margin-top: 6px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
    .span { grid-column: 1 / -1; }
    .note { background: var(--vk-warn-bg); color: var(--vk-warn); padding: 10px 12px; border-radius: 10px; margin: 4px 0 12px; }
    .err { background: var(--vk-danger-bg); color: var(--vk-danger); padding: 10px 12px; border-radius: 10px; margin-top: 8px; }
    .total { display: flex; justify-content: space-between; align-items: baseline; font: 600 20px/1.3 inherit; font-family: inherit; padding-top: 8px; }
    @media (max-width: 640px) {
      .row { grid-template-columns: minmax(0, 1fr) 0 0 130px 40px; } .row > :nth-child(2), .row > :nth-child(3) { display: none; }
      .grid { grid-template-columns: 1fr; }
    }
  `,
})
export class ReturnDialog implements OnInit {
  protected readonly data = inject<ReturnDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<ReturnDialog, ReturnResult>);
  private readonly http = inject(HttpClient);
  private readonly notify = inject(Notify);
  private readonly catalog = inject(CatalogApi);
  protected readonly reasons = REASONS;
  protected readonly inv = signal<CreditableInvoice | null>(null);
  protected readonly qty = signal<string[]>([]);
  protected readonly restock = signal<boolean[]>([]);
  protected readonly busy = signal(false);
  protected query = '';
  protected reasonPick = REASONS[0];
  protected reasonText = '';
  protected method = this.data.methods.find((m) => m.cash)?.method ?? this.data.methods[0]?.method ?? 'efectivo';
  protected buyer = { idType: '05', id: '', name: '', email: '' };

  protected readonly isCash = () => !!this.data.methods.find((m) => m.method === this.method)?.cash;

  private readonly preview = computed<{ total: string; error: string | null }>(() => {
    const i = this.inv();
    if (!i) return { total: '0', error: null };
    const picked = i.lines.map((l, k) => ({ l, q: this.qty()[k] })).filter((x) => Number(x.q) > 0);
    if (!picked.length) return { total: '0', error: null };
    try {
      const lines = picked.map(({ l, q }) =>
        creditLine(
          {
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            discount: l.discount,
            taxes: [{ taxCode: '2', percentageCode: '0', rate: l.taxRate }],
            creditedQuantity: l.credited,
            creditedDiscount: l.creditedDiscount,
          },
          q,
        ),
      );
      return { total: computeInvoice(lines).totals.total, error: null };
    } catch (e) {
      return { total: '0', error: (e as Error).message };
    }
  });
  protected readonly total = computed(() => this.preview().total);
  protected readonly calcError = computed(() => this.preview().error);

  async ngOnInit(): Promise<void> {
    if (this.data.invoiceId) await this.load(this.data.invoiceId);
  }

  private async load(id: string): Promise<void> {
    const i = await firstValueFrom(this.http.get<CreditableInvoice>(`/api/einvoice/documents/${id}/creditable`));
    this.inv.set(i);
    this.qty.set(i.lines.map(() => ''));
    this.restock.set(i.lines.map(() => true));
  }

  protected async find(): Promise<void> {
    if (!this.query.trim()) return;
    this.busy.set(true);
    try {
      const { id } = await firstValueFrom(this.http.get<{ id: string }>('/api/einvoice/invoices/find', { params: { q: this.query.trim() } }));
      await this.load(id);
    } catch (e) {
      this.notify.error(apiMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected setQty(k: number, v: string | number | null): void {
    const next = [...this.qty()];
    next[k] = v === null || v === '' ? '' : String(v);
    this.qty.set(next);
  }

  protected setRestock(k: number, v: boolean): void {
    const next = [...this.restock()];
    next[k] = v;
    this.restock.set(next);
  }

  protected all(): void {
    const i = this.inv();
    if (i) this.qty.set(i.lines.map((l) => (Number(l.remaining) > 0 ? l.remaining : '')));
  }

  protected async lookup(): Promise<void> {
    const id = this.buyer.id.trim();
    if (id.length < 10 || this.buyer.name) return;
    const p = await this.catalog.partyByIdentification(id).catch(() => null);
    if (p) this.buyer = { idType: p.idType === '04' ? '04' : p.idType === '06' ? '06' : '05', id: p.identification, name: p.name, email: p.email ?? '' };
  }

  protected async save(): Promise<void> {
    const i = this.inv();
    if (!i) return;
    const reason = this.reasonPick === 'otro' ? this.reasonText.trim() : this.reasonPick;
    if (reason.length < 3) return this.notify.error('Indique el motivo de la devolución');
    if (i.buyer.idType === '07' && (!this.buyer.id.trim() || !this.buyer.name.trim())) return this.notify.error('Ingrese la identificación y el nombre del cliente');
    const body: CreditNoteRequest = {
      invoiceId: i.id,
      emissionPointId: this.data.emissionPointId,
      reason,
      buyer:
        i.buyer.idType === '07'
          ? { idType: this.buyer.idType as '05', id: this.buyer.id.trim(), name: this.buyer.name.trim(), email: this.buyer.email.trim() || null }
          : null,
      lines: i.lines
        .map((l, k) => ({ sourceLineId: l.id, quantity: this.qty()[k], restock: this.restock()[k] }))
        .filter((l) => Number(l.quantity) > 0),
      refund: { method: this.method, cashSessionId: this.isCash() ? (this.data.cashSessionId ?? null) : null },
    };
    this.busy.set(true);
    try {
      const res = await firstValueFrom(this.http.post<ReturnResult>('/api/einvoice/credit-notes', body));
      this.ref.close(res);
    } catch (e) {
      this.notify.error(apiMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
