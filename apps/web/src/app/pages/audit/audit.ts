import { DatePipe, JsonPipe } from '@angular/common';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatSelectModule } from '@angular/material/select';
import { MatTableModule } from '@angular/material/table';
import type { AuditItem, Paginated } from '@vektra/shared-contracts';
import { firstValueFrom } from 'rxjs';
import { Notify } from '../../core/notify.service';

const ACTIONS: Record<string, string> = {
  create: 'Creó',
  update: 'Modificó',
  delete: 'Eliminó',
  'login.success': 'Ingresó',
  'login.failed': 'Intento fallido',
  'login.locked': 'Cuenta bloqueada',
  'password.changed': 'Cambió su contraseña',
  'password.reset': 'Restableció contraseña',
  unlock: 'Desbloqueó',
  '2fa.enabled': 'Activó 2FA',
  '2fa.disabled': 'Desactivó 2FA',
  'module.enabled': 'Activó módulo',
  'module.disabled': 'Desactivó módulo',
  'license.activated': 'Activó licencia',
  'token.reuse_detected': 'Sesión revocada por seguridad',
};

const ENTITIES: Record<string, string> = {
  user: 'Usuario',
  role: 'Rol',
  establishment: 'Establecimiento',
  emission_point: 'Punto de emisión',
  warehouse: 'Bodega',
  company: 'Empresa',
  session: 'Sesión',
  license: 'Licencia',
  tenant: 'Empresa',
};

@Component({
  selector: 'vk-audit',
  imports: [MatTableModule, MatPaginatorModule, MatFormFieldModule, MatSelectModule, MatButtonModule, FormsModule, DatePipe, JsonPipe],
  template: `
    <div class="vk-page">
      <div class="vk-page-header">
        <div>
          <h1>Auditoría</h1>
          <p>Quién hizo qué y cuándo. Los registros no se pueden modificar ni borrar.</p>
        </div>
        <mat-form-field class="filter">
          <mat-label>Entidad</mat-label>
          <mat-select [(ngModel)]="entity" (selectionChange)="reload()">
            <mat-option [value]="''">Todas</mat-option>
            @for (e of entityOptions; track e[0]) {
              <mat-option [value]="e[0]">{{ e[1] }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
      </div>

      <div class="vk-table-wrap">
        <table mat-table [dataSource]="rows()" multiTemplateDataRows>
          <ng-container matColumnDef="at">
            <th mat-header-cell *matHeaderCellDef>Fecha</th>
            <td mat-cell *matCellDef="let r" class="nowrap">{{ r.at | date: 'short' }}</td>
          </ng-container>
          <ng-container matColumnDef="user">
            <th mat-header-cell *matHeaderCellDef>Usuario</th>
            <td mat-cell *matCellDef="let r">{{ r.userName ?? '—' }}</td>
          </ng-container>
          <ng-container matColumnDef="action">
            <th mat-header-cell *matHeaderCellDef>Acción</th>
            <td mat-cell *matCellDef="let r">
              <strong>{{ actionLabel(r.action) }}</strong><span class="vk-muted"> · {{ entityLabel(r.entity) }}</span>
            </td>
          </ng-container>
          <ng-container matColumnDef="ip">
            <th mat-header-cell *matHeaderCellDef>IP</th>
            <td mat-cell *matCellDef="let r" class="vk-mono vk-muted">{{ r.ip ?? '' }}</td>
          </ng-container>
          <ng-container matColumnDef="detail">
            <td mat-cell *matCellDef="let r" [attr.colspan]="columns.length">
              @if (expanded() === r.id) {
                <div class="detail">
                  @if (r.before) {
                    <div><div class="vk-muted">Antes</div><pre>{{ r.before | json }}</pre></div>
                  }
                  @if (r.after) {
                    <div><div class="vk-muted">Después</div><pre>{{ r.after | json }}</pre></div>
                  }
                </div>
              }
            </td>
          </ng-container>
          <tr mat-header-row *matHeaderRowDef="columns"></tr>
          <tr mat-row *matRowDef="let r; columns: columns" class="row" (click)="toggle(r)"></tr>
          <tr mat-row *matRowDef="let r; columns: ['detail']" class="detail-row" [class.open]="expanded() === r.id"></tr>
        </table>
        @if (rows().length === 0) {
          <div class="vk-empty">Sin registros</div>
        }
        <mat-paginator [length]="total()" [pageSize]="pageSize" [pageSizeOptions]="[25, 50, 100]" (page)="page($event)" />
      </div>
    </div>
  `,
  styles: `
    .filter { width: 220px; }
    .nowrap { white-space: nowrap; }
    .row { cursor: pointer; }
    .row:hover { background: var(--mat-sys-surface-container-low); }
    .detail-row { height: 0; }
    .detail-row:not(.open) td { border-bottom-width: 0; padding: 0; }
    .detail { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; padding: 8px 0 16px; }
    pre { margin: 4px 0 0; font-size: 12px; white-space: pre-wrap; word-break: break-word; background: var(--mat-sys-surface-container-low); padding: 10px; border-radius: 8px; }
  `,
})
export class AuditPage implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly notify = inject(Notify);
  protected readonly columns = ['at', 'user', 'action', 'ip'];
  protected readonly rows = signal<AuditItem[]>([]);
  protected readonly total = signal(0);
  protected readonly expanded = signal<string | null>(null);
  protected readonly entityOptions = Object.entries(ENTITIES).filter(([k]) => k !== 'tenant');
  protected entity = '';
  protected pageSize = 50;
  private pageIndex = 0;

  ngOnInit(): void {
    void this.reload();
  }

  protected actionLabel(a: string): string {
    return ACTIONS[a] ?? a;
  }

  protected entityLabel(e: string): string {
    return ENTITIES[e] ?? e;
  }

  protected toggle(r: AuditItem): void {
    this.expanded.set(this.expanded() === r.id ? null : r.id);
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
    let params = new HttpParams().set('page', this.pageIndex + 1).set('pageSize', this.pageSize);
    if (this.entity) params = params.set('entity', this.entity);
    try {
      const res = await firstValueFrom(this.http.get<Paginated<AuditItem>>('/api/audit', { params }));
      this.rows.set(res.items);
      this.total.set(res.total);
    } catch (e) {
      this.notify.error(e);
    }
  }
}
