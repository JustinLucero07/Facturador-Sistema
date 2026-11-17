import { CurrencyPipe, DatePipe } from '@angular/common';
import { Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { Router } from '@angular/router';
import type { AccountsOverview, AccountSide } from '@vektra/shared-contracts';
import { Notify } from '../../core/notify.service';
import { AccountsApi, SIDE_TEXT } from './accounts.api';

/** Saldos por cliente (por cobrar) o por proveedor (por pagar), con antigüedad. */
@Component({
  selector: 'vk-accounts',
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatCheckboxModule, MatPaginatorModule, CurrencyPipe, DatePipe],
  template: `
    <div class="vk-page">
      <div class="vk-page-header">
        <div>
          <h1>{{ t().title }}</h1>
          <p>{{ side() === 'AR' ? 'Lo que le deben sus clientes por ventas a crédito y saldos iniciales.' : 'Lo que debe a sus proveedores por compras y saldos iniciales.' }}</p>
        </div>
      </div>

      @if (data(); as d) {
        <section class="summary">
          <div class="big">
            <span class="lbl">{{ t().owedLabel }}</span>
            <strong>{{ d.totals.owed | currency }}</strong>
            <span class="vk-muted">{{ d.totals.parties }} {{ t().parties }}</span>
          </div>
          <div class="big danger">
            <span class="lbl">Vencido</span>
            <strong>{{ d.totals.overdue | currency }}</strong>
            <span class="vk-muted">{{ pct(d.totals.overdue, d.totals.owed) }} del total</span>
          </div>
          @if (+d.totals.credit > 0) {
            <div class="big">
              <span class="lbl">Saldo a favor</span>
              <strong>{{ d.totals.credit | currency }}</strong>
              <span class="vk-muted">anticipos y notas de crédito sin aplicar</span>
            </div>
          }
          <div class="aging" role="img" [attr.aria-label]="'Antigüedad: al día ' + d.totals.buckets.current + ', vencido más de 90 días ' + d.totals.buckets.over90">
            <span class="lbl">Antigüedad</span>
            <div class="bar">
              @for (b of buckets; track b.key) {
                @if (+d.totals.buckets[b.key] > 0) { <span [class]="'seg ' + b.key" [style.flex-grow]="+d.totals.buckets[b.key]" [title]="b.label + ': ' + d.totals.buckets[b.key]"></span> }
              }
            </div>
            <div class="legend">
              @for (b of buckets; track b.key) {
                <span><i [class]="b.key"></i>{{ b.label }} <b>{{ d.totals.buckets[b.key] | currency }}</b></span>
              }
            </div>
          </div>
        </section>
      }

      <div class="filters">
        <mat-form-field class="search">
          <mat-label>Buscar {{ t().party.toLowerCase() }} (nombre o RUC)</mat-label>
          <input matInput [(ngModel)]="search" (keyup.enter)="reload(1)" />
          <span class="material-symbols-outlined" matSuffix>search</span>
        </mat-form-field>
        <mat-checkbox [(ngModel)]="overdueOnly" (ngModelChange)="reload(1)">Solo con saldo vencido</mat-checkbox>
      </div>

      <div class="vk-table-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>{{ t().party }}</th>
              <th class="r">Saldo</th>
              <th class="r">Vencido</th>
              <th class="hide-sm">Antigüedad</th>
              @if (side() === 'AR') { <th class="r hide-sm">Crédito disponible</th> }
              <th class="hide-sm">Vence primero</th>
            </tr>
          </thead>
          <tbody>
            @for (r of data()?.items ?? []; track r.partyId) {
              <tr class="click" (click)="open(r.partyId)" (keydown.enter)="open(r.partyId)" tabindex="0">
                <td>
                  <div class="name">{{ r.name }}</div>
                  <div class="vk-muted small">{{ r.identification }} · {{ r.openItems }} documento(s)@if (+r.credit > 0) { · <span class="ok">a favor {{ r.credit | currency }}</span> }</div>
                </td>
                <td class="r num">{{ r.owed | currency }}</td>
                <td class="r num" [class.bad]="+r.overdue > 0">{{ r.overdue | currency }}</td>
                <td class="hide-sm">
                  <div class="mini">
                    @for (b of buckets; track b.key) {
                      @if (+r.buckets[b.key] > 0) { <span [class]="'seg ' + b.key" [style.flex-grow]="+r.buckets[b.key]" [title]="b.label + ': ' + r.buckets[b.key]"></span> }
                    }
                  </div>
                </td>
                @if (side() === 'AR') {
                  <td class="r num hide-sm">{{ +r.creditLimit > 0 ? (available(r.creditLimit, r.owed) | currency) : '—' }}</td>
                }
                <td class="hide-sm small">{{ r.oldestDue ? (r.oldestDue | date: 'mediumDate' : 'UTC') : '—' }}</td>
              </tr>
            } @empty {
              <tr><td [attr.colspan]="side() === 'AR' ? 6 : 5" class="vk-muted empty">Sin saldos pendientes.</td></tr>
            }
          </tbody>
        </table>
        <mat-paginator [length]="data()?.total ?? 0" [pageSize]="pageSize" [pageIndex]="page - 1" (page)="paginate($event)" [pageSizeOptions]="[25, 50, 100]" />
      </div>
    </div>
  `,
  styleUrl: './accounts.scss',
})
export class AccountsPage implements OnInit {
  /** data de la ruta: AR | AP */
  readonly side = input.required<AccountSide>();
  private readonly api = inject(AccountsApi);
  private readonly notify = inject(Notify);
  private readonly router = inject(Router);
  protected readonly t = computed(() => SIDE_TEXT[this.side()]);
  protected readonly data = signal<AccountsOverview | null>(null);
  protected readonly buckets = [
    { key: 'current', label: 'Al día' },
    { key: 'd30', label: '1–30 días' },
    { key: 'd60', label: '31–60' },
    { key: 'd90', label: '61–90' },
    { key: 'over90', label: 'Más de 90' },
  ] as const;
  protected search = '';
  protected overdueOnly = false;
  protected page = 1;
  protected pageSize = 25;

  async ngOnInit(): Promise<void> {
    await this.reload(1);
  }

  protected async reload(page = this.page): Promise<void> {
    this.page = page;
    try {
      this.data.set(await this.api.overview(this.side(), { search: this.search.trim(), overdue: this.overdueOnly, page: this.page, pageSize: this.pageSize }));
    } catch (e) {
      this.notify.error(e);
    }
  }

  protected paginate(e: PageEvent): void {
    this.pageSize = e.pageSize;
    void this.reload(e.pageIndex + 1);
  }

  protected open(partyId: string): void {
    void this.router.navigate([this.t().link, partyId]);
  }

  protected pct(part: string, total: string): string {
    return Number(total) > 0 ? `${Math.round((Number(part) / Number(total)) * 100)} %` : '0 %';
  }

  protected available(limit: string, owed: string): string {
    return Math.max(0, Number(limit) - Number(owed)).toFixed(2);
  }
}
