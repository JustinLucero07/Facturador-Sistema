import { CurrencyPipe, DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import type { AccountSide, AccountStatement, CashSessionSummary, EInvoiceConfig, PaymentMethodDef, ReceivedWithholdingPreview } from '@vektra/shared-contracts';
import { firstValueFrom } from 'rxjs';
import { apiMessage } from '../../core/http';
import { Notify } from '../../core/notify.service';
import { AccountsApi, SIDE_TEXT, todayEc } from './accounts.api';

const cents = (v: string | number) => Math.round(Number(v || 0) * 100);
const fromCents = (c: number) => (c / 100).toFixed(2);

/** Cobro o pago: se reparte entre los documentos abiertos, del que vence primero al último. */
@Component({
  selector: 'vk-account-payment',
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, CurrencyPipe, DatePipe],
  template: `
    <h2 mat-dialog-title>{{ t.pay }} · {{ data.statement.party.name }}</h2>
    <mat-dialog-content class="c">
      <div class="grid">
        <mat-form-field>
          <mat-label>Valor</mat-label>
          <span matTextPrefix>$&nbsp;</span>
          <input matInput [(ngModel)]="amount" (ngModelChange)="distribute()" inputmode="decimal" cdkFocusInitial />
        </mat-form-field>
        <mat-form-field>
          <mat-label>Fecha</mat-label>
          <input matInput type="date" [(ngModel)]="date" />
        </mat-form-field>
        <mat-form-field>
          <mat-label>Medio</mat-label>
          <mat-select [(ngModel)]="method">
            @for (m of methods(); track m.method) { <mat-option [value]="m.method">{{ m.label }}</mat-option> }
          </mat-select>
        </mat-form-field>
        <mat-form-field>
          <mat-label>Referencia (transferencia, cheque…)</mat-label>
          <input matInput [(ngModel)]="reference" maxlength="100" />
        </mat-form-field>
        @if (isCash()) {
          <mat-form-field class="span">
            <mat-label>Caja</mat-label>
            <mat-select [(ngModel)]="cashSessionId">
              <mat-option [value]="null">No registrar en caja</mat-option>
              @for (s of sessions(); track s.id) { <mat-option [value]="s.id">{{ s.emissionPoint }} · abierta por {{ s.openedBy }}</mat-option> }
            </mat-select>
            <mat-hint>{{ data.side === 'AR' ? 'El efectivo entra a esta caja' : 'El efectivo sale de esta caja' }}</mat-hint>
          </mat-form-field>
        }
      </div>

      <h3>Aplicar a</h3>
      <table class="t">
        <thead><tr><th>Documento</th><th>Vence</th><th class="r">Saldo</th><th class="r">Aplicar</th></tr></thead>
        <tbody>
          @for (i of open; track i.id; let k = $index) {
            <tr>
              <td class="vk-mono">{{ i.number }}</td>
              <td [class.bad]="i.daysOverdue > 0">{{ i.dueDate | date: 'mediumDate' : 'UTC' }}@if (i.daysOverdue > 0) { <small> ({{ i.daysOverdue }} d)</small> }</td>
              <td class="r">{{ i.balance | currency }}</td>
              <td class="r"><input class="ap" [(ngModel)]="alloc[k]" (ngModelChange)="touch()" inputmode="decimal" [attr.aria-label]="'Aplicar a ' + i.number" /></td>
            </tr>
          } @empty {
            <tr><td colspan="4" class="vk-muted">No hay documentos pendientes: el valor quedará como anticipo (saldo a favor).</td></tr>
          }
        </tbody>
      </table>
      <div class="sum">
        <span>Aplicado {{ applied() | currency }}</span>
        @if (+leftover() > 0) { <span class="ok">Queda como saldo a favor: {{ leftover() | currency }}</span> }
        @if (+leftover() < 0) { <span class="bad">Lo aplicado supera el valor</span> }
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancelar</button>
      <button matButton="filled" (click)="save()" [disabled]="busy() || !(+amount > 0) || +leftover() < 0">{{ busy() ? 'Registrando…' : t.pay }}</button>
    </mat-dialog-actions>
  `,
  styleUrl: './account-dialogs.scss',
})
export class AccountPaymentDialog implements OnInit {
  protected readonly data = inject<{ side: AccountSide; statement: AccountStatement }>(MAT_DIALOG_DATA);
  private readonly api = inject(AccountsApi);
  private readonly http = inject(HttpClient);
  private readonly notify = inject(Notify);
  private readonly ref = inject(MatDialogRef<AccountPaymentDialog, boolean>);
  protected readonly t = SIDE_TEXT[this.data.side];
  protected readonly open = this.data.statement.items.filter((i) => i.status === 'OPEN').sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  protected readonly methods = signal<PaymentMethodDef[]>([]);
  protected readonly sessions = signal<CashSessionSummary[]>([]);
  protected readonly busy = signal(false);
  private readonly version = signal(0);
  protected amount = this.data.statement.owed;
  protected date = todayEc();
  protected method = 'efectivo';
  protected reference = '';
  protected cashSessionId: string | null = null;
  protected alloc: string[] = [];

  protected readonly applied = computed(() => {
    this.version();
    return fromCents(this.alloc.reduce((a, v) => a + cents(v), 0));
  });
  protected readonly leftover = computed(() => {
    this.version();
    return fromCents(cents(this.amount) - cents(this.applied()));
  });
  protected readonly isCash = () => !!this.methods().find((m) => m.method === this.method)?.cash;

  async ngOnInit(): Promise<void> {
    this.distribute();
    try {
      const cfg = await firstValueFrom(this.http.get<EInvoiceConfig>('/api/einvoice/config'));
      this.methods.set(cfg.posPaymentMethods.filter((m) => !m.credit));
      const sessions = await Promise.all(
        cfg.emissionPoints.map((p) => firstValueFrom(this.http.get<CashSessionSummary | null>('/api/cash/current', { params: { emissionPointId: p.id } })).catch(() => null)),
      );
      this.sessions.set(sessions.filter((s): s is CashSessionSummary => !!s));
      this.cashSessionId = this.sessions()[0]?.id ?? null;
    } catch (e) {
      this.notify.error(e);
    }
  }

  protected touch(): void {
    this.version.update((v) => v + 1);
  }

  /** Reparte el valor desde el documento que vence primero. */
  protected distribute(): void {
    let left = cents(this.amount);
    this.alloc = this.open.map((i) => {
      const a = Math.min(left, cents(i.balance));
      left -= a;
      return a > 0 ? fromCents(a) : '';
    });
    this.touch();
  }

  protected async save(): Promise<void> {
    this.busy.set(true);
    try {
      const allocations = this.open.map((i, k) => ({ itemId: i.id, amount: this.alloc[k] })).filter((a) => cents(a.amount) > 0);
      const res = await this.api.pay(this.data.side, {
        partyId: this.data.statement.party.id,
        kind: allocations.length ? 'PAYMENT' : 'ADVANCE',
        date: this.date,
        method: this.method,
        amount: this.amount,
        reference: this.reference.trim() || null,
        cashSessionId: this.isCash() ? this.cashSessionId : null,
        allocations: allocations.length ? allocations : null,
      });
      this.notify.ok(Number(res.unapplied) > 0 ? `${this.t.payNoun} registrado; quedan $${res.unapplied} de saldo a favor` : `${this.t.payNoun} registrado`);
      this.ref.close(true);
    } catch (e) {
      this.notify.error(apiMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}

/** Retención que le hizo un cliente: desde el XML o a mano. */
@Component({
  selector: 'vk-received-withholding',
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, CurrencyPipe],
  template: `
    <h2 mat-dialog-title>Retención recibida · {{ data.statement.party.name }}</h2>
    <mat-dialog-content class="c">
      <div class="xml">
        <input #f type="file" accept=".xml,text/xml" hidden (change)="load($event)" />
        <button matButton="outlined" (click)="f.click()"><span class="material-symbols-outlined">upload_file</span> Cargar XML de la retención</button>
        <span class="vk-muted small">o llénela a mano con los datos del comprobante físico/RIDE</span>
      </div>
      @for (w of warnings(); track w) { <div class="warn">{{ w }}</div> }
      <div class="grid">
        <mat-form-field class="span">
          <mat-label>Factura retenida</mat-label>
          <mat-select [(ngModel)]="itemId">
            @for (i of open; track i.id) { <mat-option [value]="i.id">{{ i.number }} · saldo {{ i.balance | currency }}</mat-option> }
          </mat-select>
        </mat-form-field>
        <mat-form-field>
          <mat-label>N.º de la retención</mat-label>
          <input matInput [(ngModel)]="number" placeholder="001-001-000000123" maxlength="17" />
        </mat-form-field>
        <mat-form-field>
          <mat-label>Fecha</mat-label>
          <input matInput type="date" [(ngModel)]="date" />
        </mat-form-field>
        <mat-form-field class="span">
          <mat-label>Autorización / clave de acceso</mat-label>
          <input matInput [(ngModel)]="authorization" maxlength="49" inputmode="numeric" />
        </mat-form-field>
      </div>
      <table class="t">
        <thead><tr><th>Impuesto</th><th>Código</th><th class="r">Base</th><th class="r">%</th><th class="r">Retenido</th><th></th></tr></thead>
        <tbody>
          @for (r of rows; track $index; let k = $index) {
            <tr>
              <td><select [(ngModel)]="r.tax" aria-label="Impuesto"><option value="1">Renta</option><option value="2">IVA</option></select></td>
              <td><input class="code" [(ngModel)]="r.code" aria-label="Código" /></td>
              <td class="r"><input class="ap" [(ngModel)]="r.base" (ngModelChange)="calc(k)" inputmode="decimal" aria-label="Base" /></td>
              <td class="r"><input class="ap pct" [(ngModel)]="r.percentage" (ngModelChange)="calc(k)" inputmode="decimal" aria-label="Porcentaje" /></td>
              <td class="r">{{ r.amount | currency }}</td>
              <td><button matIconButton (click)="rows.splice(k, 1)" aria-label="Quitar"><span class="material-symbols-outlined">close</span></button></td>
            </tr>
          }
        </tbody>
      </table>
      <button matButton (click)="rows.push({ tax: '1', code: '', base: '', percentage: '', amount: '0.00' })"><span class="material-symbols-outlined">add</span> Agregar línea</button>
      <div class="sum"><span>Total retenido</span><strong>{{ total() | currency }}</strong></div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancelar</button>
      <button matButton="filled" (click)="save()" [disabled]="busy() || !rows.length || !itemId">Registrar retención</button>
    </mat-dialog-actions>
  `,
  styleUrl: './account-dialogs.scss',
})
export class ReceivedWithholdingDialog {
  protected readonly data = inject<{ statement: AccountStatement }>(MAT_DIALOG_DATA);
  private readonly api = inject(AccountsApi);
  private readonly notify = inject(Notify);
  private readonly ref = inject(MatDialogRef<ReceivedWithholdingDialog, boolean>);
  protected readonly open = this.data.statement.items.filter((i) => i.status === 'OPEN' && i.sourceType === 'INVOICE');
  protected readonly warnings = signal<string[]>([]);
  protected readonly busy = signal(false);
  protected itemId = this.open[0]?.id ?? '';
  protected number = '';
  protected authorization = '';
  protected date = todayEc();
  protected rows: { tax: '1' | '2' | '6'; code: string; base: string; percentage: string; amount: string }[] = [];
  protected readonly total = () => fromCents(this.rows.reduce((a, r) => a + cents(r.amount), 0));

  protected calc(k: number): void {
    const r = this.rows[k];
    r.amount = fromCents(Math.round((Number(r.base || 0) * Number(r.percentage || 0) * 100) / 100));
  }

  protected async load(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const p: ReceivedWithholdingPreview = await this.api.withholdingPreview(file);
      if (p.partyId && p.partyId !== this.data.statement.party.id) {
        this.warnings.set([`La retención es de ${p.customerName} (${p.customerId}), no de este cliente.`]);
        return;
      }
      this.warnings.set(p.warnings);
      if (p.itemId) this.itemId = p.itemId;
      this.number = p.number;
      this.authorization = p.authorization;
      this.date = p.date;
      this.rows = p.items.map((i) => ({ ...i }));
    } catch (e) {
      this.notify.error(apiMessage(e));
    }
  }

  protected async save(): Promise<void> {
    this.busy.set(true);
    try {
      await this.api.withholding({ itemId: this.itemId, number: this.number.trim(), authorization: this.authorization.trim(), date: this.date, items: this.rows });
      this.notify.ok(`Retención registrada: ${fromCents(cents(this.total()))} menos de saldo`);
      this.ref.close(true);
    } catch (e) {
      this.notify.error(apiMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}

/** Saldo inicial: deudas que existían antes de usar el sistema. */
@Component({
  selector: 'vk-opening-item',
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule],
  template: `
    <h2 mat-dialog-title>Saldo inicial · {{ data.statement.party.name }}</h2>
    <mat-dialog-content class="c grid">
      <mat-form-field class="span">
        <mat-label>N.º del documento (factura anterior, letra, etc.)</mat-label>
        <input matInput [(ngModel)]="number" maxlength="40" cdkFocusInitial />
      </mat-form-field>
      <mat-form-field>
        <mat-label>Fecha de emisión</mat-label>
        <input matInput type="date" [(ngModel)]="issueDate" />
      </mat-form-field>
      <mat-form-field>
        <mat-label>Vence</mat-label>
        <input matInput type="date" [(ngModel)]="dueDate" />
      </mat-form-field>
      <mat-form-field>
        <mat-label>Saldo pendiente</mat-label>
        <span matTextPrefix>$&nbsp;</span>
        <input matInput [(ngModel)]="amount" inputmode="decimal" />
      </mat-form-field>
      <mat-form-field>
        <mat-label>Nota</mat-label>
        <input matInput [(ngModel)]="notes" maxlength="300" />
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancelar</button>
      <button matButton="filled" (click)="save()" [disabled]="busy()">Guardar</button>
    </mat-dialog-actions>
  `,
  styleUrl: './account-dialogs.scss',
})
export class OpeningItemDialog {
  protected readonly data = inject<{ side: AccountSide; statement: AccountStatement }>(MAT_DIALOG_DATA);
  private readonly api = inject(AccountsApi);
  private readonly notify = inject(Notify);
  private readonly ref = inject(MatDialogRef<OpeningItemDialog, boolean>);
  protected readonly busy = signal(false);
  protected number = '';
  protected issueDate = todayEc();
  protected dueDate = todayEc();
  protected amount = '';
  protected notes = 'Saldo anterior al sistema';

  protected async save(): Promise<void> {
    this.busy.set(true);
    try {
      await this.api.opening(this.data.side, { partyId: this.data.statement.party.id, number: this.number.trim(), issueDate: this.issueDate, dueDate: this.dueDate, amount: this.amount, notes: this.notes.trim() || null });
      this.ref.close(true);
    } catch (e) {
      this.notify.error(apiMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
