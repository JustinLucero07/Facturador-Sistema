import { CurrencyPipe, DatePipe } from '@angular/common';
import { Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatMenuModule } from '@angular/material/menu';
import { RouterLink } from '@angular/router';
import type { AccountSide, AccountStatement, AccountStatementMovement } from '@vektra/shared-contracts';
import { firstValueFrom } from 'rxjs';
import { apiMessage } from '../../core/http';
import { Notify } from '../../core/notify.service';
import { AccountPaymentDialog, OpeningItemDialog, ReceivedWithholdingDialog } from './account-dialogs';
import { AccountsApi, KIND_LABEL, SIDE_TEXT } from './accounts.api';

/** Estado de cuenta de un cliente o proveedor: documentos, movimientos, saldo a favor. */
@Component({
  selector: 'vk-statement',
  imports: [FormsModule, MatButtonModule, MatMenuModule, RouterLink, CurrencyPipe, DatePipe],
  template: `
    <div class="vk-page">
      <a [routerLink]="t().link" class="back"><span class="material-symbols-outlined">arrow_back</span> {{ t().title }}</a>
      @if (s(); as s) {
        <div class="vk-page-header">
          <div>
            <h1>{{ s.party.name }}</h1>
            <p class="vk-muted">{{ s.party.identification }}@if (s.party.phone) { · {{ s.party.phone }} }@if (s.party.email) { · {{ s.party.email }} } · crédito {{ s.party.creditDays }} días</p>
          </div>
          <div class="vk-actions">
            <button matButton="filled" (click)="pay()"><span class="material-symbols-outlined">payments</span> {{ t().pay }}</button>
            @if (side() === 'AR') { <button matButton="outlined" (click)="withholding()"><span class="material-symbols-outlined">receipt</span> Retención recibida</button> }
            <button matButton="outlined" (click)="opening()"><span class="material-symbols-outlined">history</span> Saldo inicial</button>
          </div>
        </div>

        <section class="kpis">
          <div><span class="lbl">Saldo</span><strong>{{ s.owed | currency }}</strong></div>
          <div><span class="lbl">Vencido</span><strong [class.bad]="+s.overdue > 0">{{ s.overdue | currency }}</strong></div>
          <div><span class="lbl">Saldo a favor</span><strong [class.ok]="+s.credit > 0">{{ s.credit | currency }}</strong></div>
          @if (s.available !== null) { <div><span class="lbl">Crédito disponible</span><strong>{{ s.available | currency }}</strong><small class="vk-muted">de {{ s.party.creditLimit | currency }}</small></div> }
        </section>

        <h2>Documentos</h2>
        <div class="vk-table-wrap">
          <table class="tbl">
            <thead><tr><th>Documento</th><th>Emisión</th><th>Vence</th><th class="r">Valor</th><th class="r">Saldo</th><th>Estado</th></tr></thead>
            <tbody>
              @for (i of s.items; track i.id) {
                <tr [class.dim]="i.status !== 'OPEN'">
                  <td>
                    @if (i.sourceType === 'INVOICE') { <a [routerLink]="['/facturacion/comprobantes', i.sourceId]" class="vk-mono">{{ i.number }}</a> }
                    @else if (i.sourceType === 'PURCHASE') { <a routerLink="/compras" [queryParams]="{ ver: i.sourceId }" class="vk-mono">{{ i.number }}</a> }
                    @else { <span class="vk-mono">{{ i.number }}</span>&nbsp;<small class="vk-muted">· saldo inicial</small> }
                  </td>
                  <td>{{ i.issueDate | date: 'mediumDate' : 'UTC' }}</td>
                  <td>{{ i.dueDate | date: 'mediumDate' : 'UTC' }}</td>
                  <td class="r num">{{ i.amount | currency }}</td>
                  <td class="r num">{{ i.balance | currency }}</td>
                  <td>
                    @switch (i.status) {
                      @case ('PAID') { <span class="vk-badge ok">Pagado</span> }
                      @case ('VOID') { <span class="vk-badge">Anulado</span> }
                      @default {
                        @if (i.daysOverdue > 0) { <span class="vk-badge danger">Vencido {{ i.daysOverdue }} d</span> } @else { <span class="vk-badge brand">Por vencer</span> }
                      }
                    }
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="6" class="vk-muted empty">Sin documentos.</td></tr>
              }
            </tbody>
          </table>
        </div>

        <h2>Movimientos</h2>
        <div class="vk-table-wrap">
          <table class="tbl">
            <thead><tr><th>Fecha</th><th>Tipo</th><th>Detalle</th><th class="r">Valor</th><th class="r">A favor</th><th></th></tr></thead>
            <tbody>
              @for (m of s.movements; track m.id) {
                <tr [class.dim]="m.voided">
                  <td>{{ m.date | date: 'mediumDate' : 'UTC' }}</td>
                  <td>{{ kind(m.kind) }}@if (m.method) { <small class="vk-muted"> · {{ m.method }}</small> }</td>
                  <td>
                    <div class="det">
                      @if (m.reference) { <span class="vk-mono">{{ m.reference }}</span> }
                      @if (m.allocations.length) { <small class="vk-muted">aplicado a {{ applied(m) }}</small> }
                      @if (m.voided) { <small class="bad">Anulado: {{ m.voidReason }}</small> }
                    </div>
                  </td>
                  <td class="r num">{{ m.amount | currency }}</td>
                  <td class="r num" [class.ok]="+m.unapplied > 0">{{ +m.unapplied > 0 ? (m.unapplied | currency) : '' }}</td>
                  <td class="r">
                    @if (!m.voided) {
                      <button matIconButton [matMenuTriggerFor]="menu" [attr.aria-label]="'Acciones del movimiento ' + (m.reference ?? '')"><span class="material-symbols-outlined">more_vert</span></button>
                      <mat-menu #menu="matMenu" xPosition="before">
                        @if (+m.unapplied > 0 && openItems().length) {
                          @for (i of openItems(); track i.id) {
                            <button mat-menu-item (click)="useCredit(m, i.id, i.balance)">Aplicar a {{ i.number }} (saldo {{ i.balance | currency }})</button>
                          }
                        }
                        @if (!m.documentId) { <button mat-menu-item (click)="voidMv(m)"><span class="material-symbols-outlined">block</span><span>Anular</span></button> }
                        @else { <button mat-menu-item disabled>Viene de un comprobante electrónico</button> }
                      </mat-menu>
                    }
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="6" class="vk-muted empty">Sin movimientos.</td></tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>
  `,
  styles: `
    .back { display: inline-flex; align-items: center; gap: 4px; color: var(--mat-sys-primary); text-decoration: none; margin-bottom: 8px; }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .kpis div { display: flex; flex-direction: column; padding: 14px 16px; border-radius: 14px; background: var(--mat-sys-surface); border: 1px solid var(--mat-sys-outline-variant); }
    .kpis strong { font: 700 22px/1.3 var(--mat-sys-body-large-font); font-variant-numeric: tabular-nums; }
    .lbl { font: var(--mat-sys-label-medium); color: var(--vk-muted); text-transform: uppercase; letter-spacing: 0.04em; }
    h2 { font: var(--mat-sys-title-medium); margin: 8px 0; }
    .tbl { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
    .tbl th, .tbl td { padding: 9px 12px; border-bottom: 1px solid var(--mat-sys-outline-variant); text-align: left; vertical-align: middle; }
    .tbl th { font: var(--mat-sys-label-medium); color: var(--vk-muted); }
    .r { text-align: right !important; }
    .num { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .det { display: flex; flex-direction: column; gap: 2px; }
    .dim { opacity: 0.55; }
    .bad { color: var(--vk-danger); }
    .ok { color: var(--vk-success); }
    .empty { padding: 18px 12px; }
  `,
})
export class StatementPage implements OnInit {
  readonly side = input.required<AccountSide>();
  readonly partyId = input.required<string>();
  private readonly api = inject(AccountsApi);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(Notify);
  protected readonly t = computed(() => SIDE_TEXT[this.side()]);
  protected readonly s = signal<AccountStatement | null>(null);
  protected readonly openItems = computed(() => (this.s()?.items ?? []).filter((i) => i.status === 'OPEN'));
  protected readonly kind = (k: string) => KIND_LABEL[k] ?? k;

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  private async load(): Promise<void> {
    try {
      this.s.set(await this.api.statement(this.side(), this.partyId()));
    } catch (e) {
      this.notify.error(e);
    }
  }

  protected applied(m: AccountStatementMovement): string {
    return m.allocations.map((a) => `${a.number} (${a.amount})`).join(', ');
  }

  private async openDialog(cmp: typeof AccountPaymentDialog | typeof ReceivedWithholdingDialog | typeof OpeningItemDialog): Promise<void> {
    const s = this.s();
    if (!s) return;
    const ok = await firstValueFrom(this.dialog.open(cmp as typeof AccountPaymentDialog, { data: { side: this.side(), statement: s }, maxWidth: '96vw' }).afterClosed());
    if (ok) await this.load();
  }

  protected pay(): Promise<void> {
    return this.openDialog(AccountPaymentDialog);
  }

  protected withholding(): Promise<void> {
    return this.openDialog(ReceivedWithholdingDialog);
  }

  protected opening(): Promise<void> {
    return this.openDialog(OpeningItemDialog);
  }

  protected async useCredit(m: AccountStatementMovement, itemId: string, balance: string): Promise<void> {
    const amount = Math.min(Number(m.unapplied), Number(balance)).toFixed(2);
    try {
      await this.api.applyCredit(this.side(), { movementId: m.id, itemId, amount });
      this.notify.ok(`Saldo a favor aplicado: $${amount}`);
      await this.load();
    } catch (e) {
      this.notify.error(apiMessage(e));
    }
  }

  protected async voidMv(m: AccountStatementMovement): Promise<void> {
    const ok = await this.notify.confirm({
      title: 'Anular movimiento',
      message: `Se anulará ${this.kind(m.kind).toLowerCase()} de $${m.amount}. Los documentos que cancelaba vuelven a quedar pendientes${m.method === 'efectivo' ? ' y, si la caja sigue abierta, el efectivo se revierte en ella' : ''}.`,
      confirmLabel: 'Anular',
      danger: true,
    });
    if (!ok) return;
    try {
      await this.api.voidMovement(this.side(), m.id, 'Anulado por el usuario');
      this.notify.ok('Movimiento anulado');
      await this.load();
    } catch (e) {
      this.notify.error(apiMessage(e));
    }
  }
}
