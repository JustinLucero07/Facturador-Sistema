import { CurrencyPipe } from '@angular/common';
import { Component, computed, ElementRef, HostListener, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import type { PaymentMethodDef } from '@vektra/shared-contracts';
import { Keypad } from './keypad';

export interface PaymentResult {
  method: string;
  sriCode: string;
  amount: string;
  cashReceived?: string | null;
  reference?: string | null;
}

interface Row extends PaymentResult {
  label: string;
}

const cents = (v: string | number) => Math.round(Number(v || 0) * 100);
const fmt = (c: number) => (c / 100).toFixed(2);

/**
 * Cobro: pagos mixtos, efectivo con vuelto y billetes rápidos.
 * Enter confirma cuando el total está cubierto.
 */
@Component({
  selector: 'vk-payment-dialog',
  imports: [FormsModule, MatDialogModule, MatButtonModule, Keypad, CurrencyPipe],
  template: `
    <div class="head">
      <div>
        <div class="vk-muted">Total a cobrar</div>
        <div class="total">{{ data.total | currency }}</div>
      </div>
      <div class="right">
        @if (remaining() > 0) {
          <div class="vk-muted">Falta</div><div class="remaining">{{ remaining() / 100 | currency }}</div>
        } @else if (change() > 0) {
          <div class="vk-muted">Cambio</div><div class="change">{{ change() / 100 | currency }}</div>
        } @else {
          <div class="ok">Cubierto ✓</div>
        }
      </div>
    </div>

    <mat-dialog-content class="body">
      <div class="left">
        <div class="methods">
          @for (m of data.methods; track m.method) {
            <button type="button" class="method" [class.active]="current().method === m.method" [disabled]="m.credit && !data.identified" (click)="choose(m)">
              {{ m.label }}
            </button>
          }
        </div>

        @if (rows().length) {
          <ul class="rows">
            @for (r of rows(); track $index; let i = $index) {
              <li>
                <span>{{ r.label }}{{ r.reference ? ' · ' + r.reference : '' }}</span>
                <span class="amt">{{ r.amount | currency }}</span>
                <button matIconButton (click)="remove(i)" aria-label="Quitar pago"><span class="material-symbols-outlined">close</span></button>
              </li>
            }
          </ul>
        }

        <div class="entry">
          <label>
            <span class="vk-muted">{{ isCash() ? 'Efectivo recibido' : 'Monto ' + current().label }}</span>
            <input #amount class="amount" [ngModel]="input()" (ngModelChange)="typed($event)" (focus)="amount.select()" inputmode="decimal" cdkFocusInitial />
          </label>
          @if (current().reference) {
            <label>
              <span class="vk-muted">Referencia / voucher</span>
              <input class="ref" [(ngModel)]="reference" />
            </label>
          }
          @if (isCash()) {
            <div class="bills">
              <button type="button" (click)="suggest(fmt(cents(data.total) - paid()))">Exacto</button>
              @for (b of bills; track b) { <button type="button" (click)="pick(b)">\${{ b }}</button> }
            </div>
          }
          <button matButton="tonal" class="add" (click)="add()" [disabled]="!input() || cents(input()) <= 0">
            Agregar {{ current().label }}
          </button>
        </div>
      </div>
      <div class="pad"><vk-keypad [(fresh)]="fresh" [value]="input()" (valueChange)="input.set($event)" /></div>
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancelar (Esc)</button>
      <button matButton="filled" class="confirm" (click)="confirm()" [disabled]="!canConfirm()">
        Cobrar y facturar (Enter)
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    .head { display: flex; justify-content: space-between; align-items: flex-end; padding: 20px 24px 8px; gap: 16px; }
    .total { font: 700 40px/1.1 var(--mat-sys-body-large-font); font-variant-numeric: tabular-nums; }
    .right { text-align: right; }
    .remaining { font: 600 28px/1.1 var(--mat-sys-body-large-font); color: var(--vk-warn); }
    .change { font: 700 32px/1.1 var(--mat-sys-body-large-font); color: var(--vk-success); }
    .ok { font: 600 22px/1 var(--mat-sys-body-large-font); color: var(--vk-success); }
    .body { display: grid; grid-template-columns: 1fr 240px; gap: 20px; }
    .methods { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 8px; }
    .method { min-height: 52px; border-radius: 12px; border: 1px solid var(--mat-sys-outline-variant); background: var(--mat-sys-surface); font: var(--mat-sys-label-large); cursor: pointer; color: var(--mat-sys-on-surface); }
    .method.active { border: 2px solid var(--mat-sys-primary); background: var(--mat-sys-primary-container); color: var(--mat-sys-on-primary-container); }
    .method:disabled { opacity: .4; cursor: not-allowed; }
    .rows { list-style: none; padding: 0; margin: 12px 0 0; }
    .rows li { display: flex; align-items: center; gap: 8px; padding: 4px 0; border-bottom: 1px solid var(--mat-sys-outline-variant); }
    .rows li span:first-child { flex: 1; } .amt { font-weight: 600; font-variant-numeric: tabular-nums; }
    .entry { display: flex; flex-direction: column; gap: 10px; margin-top: 14px; }
    label { display: flex; flex-direction: column; gap: 4px; }
    .amount { font: 600 28px/1 var(--mat-sys-body-large-font); padding: 10px 12px; border: 2px solid var(--mat-sys-primary); border-radius: 12px; text-align: right; width: 100%; box-sizing: border-box; background: var(--mat-sys-surface); color: inherit; }
    .ref { padding: 10px 12px; border: 1px solid var(--mat-sys-outline); border-radius: 10px; font: inherit; background: var(--mat-sys-surface); color: inherit; }
    .bills { display: flex; gap: 6px; flex-wrap: wrap; }
    .bills button { min-height: 44px; min-width: 64px; border-radius: 10px; border: 1px solid var(--mat-sys-outline-variant); background: var(--mat-sys-surface-container-low); font-weight: 600; font-size: 15px; line-height: 1; font-family: inherit; cursor: pointer; color: inherit; }
    .add { min-height: 44px; }
    .confirm { min-height: 52px; font-size: 16px; padding: 0 24px; }
    @media (max-width: 699px) { .body { grid-template-columns: 1fr; } .pad { display: none; } }
  `,
})
export class PaymentDialog {
  protected readonly data = inject<{ total: string; methods: PaymentMethodDef[]; identified: boolean }>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<PaymentDialog, PaymentResult[]>);
  protected readonly fmt = fmt;
  protected readonly cents = cents;
  protected readonly bills = [1, 5, 10, 20, 50, 100];
  protected readonly rows = signal<Row[]>([]);
  protected readonly current = signal<PaymentMethodDef>(this.data.methods.find((m) => m.cash) ?? this.data.methods[0]);
  protected readonly input = signal(this.data.total);
  /** El monto mostrado es el sugerido (saldo): teclear lo reemplaza. */
  protected readonly fresh = signal(true);
  private readonly amountEl = viewChild<ElementRef<HTMLInputElement>>('amount');
  protected reference = '';

  protected readonly isCash = computed(() => !!this.current().cash);
  protected readonly paid = computed(() => this.rows().reduce((s, r) => s + cents(r.amount), 0));
  protected readonly remaining = computed(() => Math.max(0, cents(this.data.total) - this.paid() - (this.pendingApplies() ? this.pendingApplied() : 0)));
  /** El monto escrito y aún no agregado cuenta para el cálculo (flujo rápido: escribir y Enter). */
  private readonly pendingApplies = computed(() => cents(this.input()) > 0);
  private readonly pendingApplied = computed(() => Math.min(cents(this.input()), Math.max(0, cents(this.data.total) - this.paid())));
  protected readonly change = computed(() => {
    const due = cents(this.data.total) - this.paid();
    const cashRow = this.rows().find((r) => r.cashReceived);
    if (this.isCash() && cents(this.input()) > due && due > 0) return cents(this.input()) - due;
    return cashRow ? cents(cashRow.cashReceived ?? 0) - cents(cashRow.amount) : 0;
  });
  protected readonly canConfirm = computed(() => this.remaining() === 0 && (this.paid() > 0 || this.pendingApplies()));

  protected typed(v: string): void {
    this.fresh.set(false);
    this.input.set(v);
  }

  /** Precarga un monto sugerido y lo deja seleccionado para reemplazarlo al teclear. */
  protected pick(bill: number): void {
    this.input.set(bill.toFixed(2));
    this.fresh.set(true);
  }

  protected suggest(v: string): void {
    this.input.set(v);
    this.fresh.set(true);
    setTimeout(() => this.amountEl()?.nativeElement.select());
  }

  protected choose(m: PaymentMethodDef): void {
    this.current.set(m);
    this.reference = '';
    const due = cents(this.data.total) - this.paid();
    this.suggest(due > 0 ? fmt(due) : '');
  }

  protected add(): void {
    const due = cents(this.data.total) - this.paid();
    const given = cents(this.input());
    if (given <= 0 || due <= 0) return;
    const m = this.current();
    const applied = Math.min(given, due);
    this.rows.set([
      ...this.rows(),
      {
        method: m.method,
        sriCode: m.sriCode,
        label: m.label,
        amount: fmt(applied),
        cashReceived: m.cash ? fmt(given) : null,
        reference: this.reference || null,
      },
    ]);
    this.reference = '';
    this.suggest(due - applied > 0 ? fmt(due - applied) : '');
  }

  protected remove(i: number): void {
    this.rows.set(this.rows().filter((_, k) => k !== i));
    this.suggest(fmt(cents(this.data.total) - this.paid()));
  }

  @HostListener('document:keydown.enter', ['$event'])
  protected onEnter(ev: Event): void {
    ev.preventDefault();
    this.confirm();
  }

  protected confirm(): void {
    if (cents(this.input()) > 0 && cents(this.data.total) - this.paid() > 0) this.add();
    if (this.remaining() !== 0 || !this.rows().length) return;
    this.ref.close(this.rows().map(({ label: _l, ...r }) => r));
  }
}
