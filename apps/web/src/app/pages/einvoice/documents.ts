import { CurrencyPipe, DatePipe } from '@angular/common';
import { Component, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router, RouterLink } from '@angular/router';
import { EDOC_STATUS_LABELS, type EDocListItem, type EDocStatusCode } from '@vektra/shared-contracts';
import { AuthService } from '../../core/auth.service';
import { Notify } from '../../core/notify.service';
import { EInvoiceApi, STATUS_CLASS } from './einvoice.api';

const FILTERS: { value: EDocStatusCode | ''; label: string }[] = [
  { value: '', label: 'Todos' },
  { value: 'AUTHORIZED', label: 'Autorizados' },
  { value: 'RECEIVED', label: 'En proceso' },
  { value: 'CONTINGENCY', label: 'En contingencia' },
  { value: 'RETURNED', label: 'Devueltos' },
  { value: 'NOT_AUTHORIZED', label: 'No autorizados' },
];

@Component({
  selector: 'vk-documents',
  imports: [MatTableModule, MatPaginatorModule, MatChipsModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatTooltipModule, FormsModule, DatePipe, CurrencyPipe, RouterLink],
  template: `
    <div class="vk-page">
      <div class="vk-page-header">
        <div>
          <h1>Comprobantes electrónicos</h1>
          <p>Estado de cada comprobante en el SRI. Se actualiza automáticamente.</p>
        </div>
        @if (auth.can('sales.create')) {
          <a matButton="filled" routerLink="/facturacion/nueva"><span class="material-symbols-outlined">add</span> Nueva factura</a>
        }
      </div>

      <div class="filters">
        <mat-chip-listbox [(ngModel)]="status" (change)="reload()" aria-label="Filtrar por estado">
          @for (f of filters; track f.value) {
            <mat-chip-option [value]="f.value">{{ f.label }}</mat-chip-option>
          }
        </mat-chip-listbox>
        <mat-form-field class="search">
          <mat-label>Buscar cliente, cédula/RUC o clave</mat-label>
          <input matInput [(ngModel)]="search" (keyup.enter)="reload()" />
          <span class="material-symbols-outlined" matSuffix>search</span>
        </mat-form-field>
      </div>

      <div class="vk-table-wrap">
        <table mat-table [dataSource]="rows()">
          <ng-container matColumnDef="number">
            <th mat-header-cell *matHeaderCellDef>Factura</th>
            <td mat-cell *matCellDef="let r">
              <span class="vk-mono num">{{ r.number }}</span>
              <div class="vk-muted small">{{ r.issueDate | date: 'mediumDate' : 'UTC' }}</div>
            </td>
          </ng-container>
          <ng-container matColumnDef="buyer">
            <th mat-header-cell *matHeaderCellDef>Cliente</th>
            <td mat-cell *matCellDef="let r">
              {{ r.buyerName }}
              <div class="vk-muted small vk-mono">{{ r.buyerId }}</div>
            </td>
          </ng-container>
          <ng-container matColumnDef="total">
            <th mat-header-cell *matHeaderCellDef class="right">Total</th>
            <td mat-cell *matCellDef="let r" class="right num">{{ r.total | currency }}</td>
          </ng-container>
          <ng-container matColumnDef="status">
            <th mat-header-cell *matHeaderCellDef>Estado SRI</th>
            <td mat-cell *matCellDef="let r">
              <span class="vk-badge" [class]="'vk-badge ' + statusClass[r.status]">{{ label(r.status) }}</span>
              @if (r.environment === 1) {
                <span class="vk-muted small"> · pruebas</span>
              }
            </td>
          </ng-container>
          <ng-container matColumnDef="email">
            <th mat-header-cell *matHeaderCellDef>Correo</th>
            <td mat-cell *matCellDef="let r">
              <span class="material-symbols-outlined mail" [class]="'mail ' + r.emailStatus" [matTooltip]="emailLabel[r.emailStatus]">{{ emailIcon[r.emailStatus] }}</span>
            </td>
          </ng-container>
          <tr mat-header-row *matHeaderRowDef="columns"></tr>
          <tr mat-row *matRowDef="let r; columns: columns" class="row" (click)="open(r)"></tr>
        </table>
        @if (rows().length === 0) {
          <div class="vk-empty">No hay comprobantes{{ status ? ' con este estado' : '' }}.</div>
        }
        <mat-paginator [length]="total()" [pageSize]="pageSize" [pageSizeOptions]="[25, 50, 100]" (page)="page($event)" />
      </div>
    </div>
  `,
  styles: `
    .filters { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
    .search { flex: 1; min-width: 240px; }
    .num { font-variant-numeric: tabular-nums; }
    .small { font: var(--mat-sys-body-small); }
    .right { text-align: right; }
    .row { cursor: pointer; }
    .row:hover { background: var(--mat-sys-surface-container-low); }
    .mail { font-size: 20px; color: var(--vk-muted); }
    .mail.SENT { color: var(--vk-success); }
    .mail.FAILED { color: var(--vk-danger); }
  `,
})
export class DocumentsPage implements OnInit, OnDestroy {
  private readonly api = inject(EInvoiceApi);
  private readonly notify = inject(Notify);
  private readonly router = inject(Router);
  protected readonly auth = inject(AuthService);
  protected readonly filters = FILTERS;
  protected readonly statusClass: Record<string, string> = STATUS_CLASS;
  protected readonly columns = ['number', 'buyer', 'total', 'status', 'email'];
  protected readonly emailIcon: Record<string, string> = { PENDING: 'schedule_send', SENT: 'mark_email_read', FAILED: 'unsubscribe', SKIPPED: 'mail_off' };
  protected readonly emailLabel: Record<string, string> = { PENDING: 'Correo pendiente', SENT: 'Correo enviado', FAILED: 'Falló el envío del correo', SKIPPED: 'Sin envío de correo' };
  protected readonly rows = signal<EDocListItem[]>([]);
  protected readonly total = signal(0);
  protected status: EDocStatusCode | '' = '';
  protected search = '';
  protected pageSize = 25;
  private pageIndex = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  ngOnInit(): void {
    void this.reload();
    this.timer = setInterval(() => {
      if (this.rows().some((r) => ['SIGNED', 'SENT', 'RECEIVED', 'CONTINGENCY'].includes(r.status) || r.emailStatus === 'PENDING')) void this.fetch();
    }, 5000);
  }

  ngOnDestroy(): void {
    clearInterval(this.timer);
  }

  protected label(s: EDocStatusCode): string {
    return EDOC_STATUS_LABELS[s];
  }

  protected open(r: EDocListItem): void {
    void this.router.navigate(['/facturacion/comprobantes', r.id]);
  }

  protected page(e: PageEvent): void {
    this.pageIndex = e.pageIndex;
    this.pageSize = e.pageSize;
    void this.fetch();
  }

  protected reload(): Promise<void> {
    this.pageIndex = 0;
    return this.fetch();
  }

  private async fetch(): Promise<void> {
    try {
      const res = await this.api.list({ status: this.status, search: this.search.trim(), page: this.pageIndex + 1, pageSize: this.pageSize });
      this.rows.set(res.items);
      this.total.set(res.total);
    } catch (e) {
      this.notify.error(e);
    }
  }
}
