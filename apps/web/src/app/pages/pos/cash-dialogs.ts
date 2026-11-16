import { CurrencyPipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import type { CashSessionSummary } from '@vektra/shared-contracts';
import { Notify } from '../../core/notify.service';
import { Keypad } from './keypad';
import { PosApi } from './pos.api';

@Component({
  selector: 'vk-open-cash',
  imports: [FormsModule, MatDialogModule, MatButtonModule, Keypad],
  template: `
    <h2 mat-dialog-title>Abrir caja</h2>
    <mat-dialog-content class="c">
      <p class="vk-muted">{{ data.label }}</p>
      <label for="vk-open-amount">Fondo inicial (efectivo en caja)</label>
      <input id="vk-open-amount" class="amount" [ngModel]="amount()" (ngModelChange)="amount.set($event)" inputmode="decimal" cdkFocusInitial (keydown.enter)="open()" />
      <vk-keypad [value]="amount()" (valueChange)="amount.set($event)" />
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancelar</button>
      <button matButton="filled" (click)="open()" [disabled]="busy()">Abrir caja</button>
    </mat-dialog-actions>
  `,
  styles: `
    .c { display: flex; flex-direction: column; gap: 10px; width: 300px; max-width: 100%; }
    .amount { font-weight: 600; font-size: 28px; line-height: 1; font-family: inherit; padding: 10px; border: 2px solid var(--mat-sys-primary); border-radius: 12px; text-align: right; background: var(--mat-sys-surface); color: inherit; }
  `,
})
export class OpenCashDialog {
  protected readonly data = inject<{ emissionPointId: string; label: string }>(MAT_DIALOG_DATA);
  private readonly api = inject(PosApi);
  private readonly notify = inject(Notify);
  private readonly ref = inject(MatDialogRef<OpenCashDialog, CashSessionSummary>);
  protected readonly amount = signal('0');
  protected readonly busy = signal(false);

  protected async open(): Promise<void> {
    this.busy.set(true);
    try {
      this.ref.close(await this.api.openCash(this.data.emissionPointId, this.amount() || '0'));
    } catch (e) {
      this.notify.error(e);
    } finally {
      this.busy.set(false);
    }
  }
}

@Component({
  selector: 'vk-cash-movement',
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatButtonToggleModule, MatFormFieldModule, MatInputModule, Keypad],
  template: `
    <h2 mat-dialog-title>Ingreso / egreso de caja</h2>
    <mat-dialog-content class="c">
      <mat-button-toggle-group [(ngModel)]="type" aria-label="Tipo">
        <mat-button-toggle value="OUT">Egreso (sale dinero)</mat-button-toggle>
        <mat-button-toggle value="IN">Ingreso (entra dinero)</mat-button-toggle>
      </mat-button-toggle-group>
      <input class="amount" [ngModel]="amount()" (ngModelChange)="amount.set($event)" inputmode="decimal" placeholder="0.00" />
      <mat-form-field><mat-label>Motivo</mat-label><input matInput [(ngModel)]="reason" placeholder="Ej.: pago de agua, cambio, retiro" /></mat-form-field>
      <vk-keypad [value]="amount()" (valueChange)="amount.set($event)" />
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancelar</button>
      <button matButton="filled" (click)="save()" [disabled]="busy() || !(+amount() > 0) || reason.trim().length < 3">Registrar</button>
    </mat-dialog-actions>
  `,
  styles: `
    .c { display: flex; flex-direction: column; gap: 10px; width: 340px; max-width: 100%; }
    .amount { font-weight: 600; font-size: 28px; line-height: 1; font-family: inherit; padding: 10px; border: 2px solid var(--mat-sys-primary); border-radius: 12px; text-align: right; background: var(--mat-sys-surface); color: inherit; }
  `,
})
export class CashMovementDialog {
  private readonly sessionId = inject<{ sessionId: string }>(MAT_DIALOG_DATA).sessionId;
  private readonly api = inject(PosApi);
  private readonly notify = inject(Notify);
  private readonly ref = inject(MatDialogRef<CashMovementDialog, CashSessionSummary>);
  protected type: 'IN' | 'OUT' = 'OUT';
  protected reason = '';
  protected readonly amount = signal('');
  protected readonly busy = signal(false);

  protected async save(): Promise<void> {
    this.busy.set(true);
    try {
      const s = await this.api.cashMovement(this.sessionId, { type: this.type, amount: this.amount(), reason: this.reason.trim() });
      this.notify.ok(this.type === 'IN' ? 'Ingreso registrado' : 'Egreso registrado');
      this.ref.close(s);
    } catch (e) {
      this.notify.error(e);
    } finally {
      this.busy.set(false);
    }
  }
}

const DENOMS = ['100', '50', '20', '10', '5', '1', '0.50', '0.25', '0.10', '0.05', '0.01'];

/** Arqueo y cierre: se cuenta el efectivo (billetes y monedas) y se declara lo cobrado por otros medios. */
@Component({
  selector: 'vk-close-cash',
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, CurrencyPipe],
  template: `
    <h2 mat-dialog-title>Arqueo y cierre de caja</h2>
    <mat-dialog-content>
      <p class="vk-muted">{{ s.emissionPoint }} · abierta por {{ s.openedBy }} · {{ s.invoices }} factura(s) · vendido {{ s.totalSales | currency }}</p>
      <div class="grid">
        <section>
          <h3>Conteo de efectivo</h3>
          <table class="den">
            @for (d of denoms; track d) {
              <tr>
                <td>{{ +d | currency }}</td>
                <td>× <input class="qty" type="number" min="0" [ngModel]="counts()[d] || null" (ngModelChange)="setCount(d, $event)" /></td>
                <td class="r">{{ +d * (counts()[d] || 0) | currency }}</td>
              </tr>
            }
          </table>
          <div class="cash-total">Efectivo contado: <strong>{{ cashCounted() | currency }}</strong></div>
        </section>
        <section>
          <h3>Otros medios</h3>
          @for (m of others; track m.method) {
            <mat-form-field class="w">
              <mat-label>{{ m.label }} ({{ m.count }} venta{{ m.count === 1 ? '' : 's' }})</mat-label>
              <input matInput inputmode="decimal" [(ngModel)]="other[m.method]" />
              <mat-hint>Sume vouchers/comprobantes de {{ m.label.toLowerCase() }}</mat-hint>
            </mat-form-field>
          } @empty {
            <p class="vk-muted">Sin ventas con otros medios.</p>
          }
          <mat-form-field class="w"><mat-label>Observaciones</mat-label><textarea matInput rows="2" [(ngModel)]="notes"></textarea></mat-form-field>
        </section>
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancelar</button>
      <button matButton="filled" (click)="close()" [disabled]="busy()">Cerrar caja</button>
    </mat-dialog-actions>
  `,
  styles: `
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
    h3 { font: var(--mat-sys-title-small); margin: 0 0 8px; }
    .den { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
    .den td { padding: 2px 4px; } .r { text-align: right; }
    .qty { width: 70px; padding: 6px; border: 1px solid var(--mat-sys-outline-variant); border-radius: 6px; font: inherit; background: var(--mat-sys-surface); color: inherit; }
    .cash-total { margin-top: 8px; font: var(--mat-sys-title-medium); }
    .w { width: 100%; }
    @media (max-width: 699px) { .grid { grid-template-columns: 1fr; } }
  `,
})
export class CloseCashDialog {
  protected readonly s = inject<CashSessionSummary>(MAT_DIALOG_DATA);
  private readonly api = inject(PosApi);
  private readonly notify = inject(Notify);
  private readonly ref = inject(MatDialogRef<CloseCashDialog, CashSessionSummary>);
  protected readonly denoms = DENOMS;
  protected readonly counts = signal<Record<string, number>>({});
  protected readonly cashCounted = computed(() => Object.entries(this.counts()).reduce((a, [d, n]) => a + Number(d) * (n || 0), 0).toFixed(2));
  protected readonly others = this.s.methods.filter((m) => m.method !== 'efectivo' && m.count > 0);
  protected other: Record<string, string> = {};
  protected notes = '';
  protected readonly busy = signal(false);

  protected setCount(d: string, n: number | null): void {
    this.counts.set({ ...this.counts(), [d]: Math.max(0, Math.floor(Number(n) || 0)) });
  }

  protected async close(): Promise<void> {
    this.busy.set(true);
    try {
      const counted: Record<string, string> = { efectivo: this.cashCounted() };
      for (const m of this.others) counted[m.method] = (this.other[m.method] || '0').replace(',', '.');
      const denominations = Object.fromEntries(Object.entries(this.counts()).filter(([, n]) => n > 0));
      this.ref.close(await this.api.closeCash(this.s.id, { counted, denominations, notes: this.notes || null }));
    } catch (e) {
      this.notify.error(e);
    } finally {
      this.busy.set(false);
    }
  }
}
