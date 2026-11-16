import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import type { CatalogLookups, StockItem } from '@vektra/shared-contracts';
import { AuthService } from '../../core/auth.service';
import { Notify } from '../../core/notify.service';
import { CatalogApi } from '../catalog/catalog.api';
import { KardexDialog } from './kardex-dialog';
import { MovementDialog } from './movement-dialog';

@Component({
  selector: 'vk-stock',
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatSlideToggleModule, MatPaginatorModule],
  template: `
    <div class="vk-page">
      <div class="vk-page-header">
        <div>
          <h1>Inventario</h1>
          <p>Existencias por bodega valoradas al costo promedio ponderado.</p>
        </div>
        @if (auth.can('inventory.adjust')) {
          <div class="vk-actions">
            <button matButton="outlined" (click)="movement('transfer')"><span class="material-symbols-outlined">swap_horiz</span> Transferir</button>
            <button matButton="filled" (click)="movement('adjust')"><span class="material-symbols-outlined">tune</span> Ajuste</button>
          </div>
        }
      </div>

      <div class="filters">
        <mat-form-field>
          <mat-label>Bodega</mat-label>
          <mat-select [(ngModel)]="warehouseId" (selectionChange)="reload()">
            <mat-option [value]="''">Todas las bodegas</mat-option>
            @for (w of lk()?.warehouses ?? []; track w.id) { <mat-option [value]="w.id">{{ w.name }} · {{ w.establishment }}</mat-option> }
          </mat-select>
        </mat-form-field>
        <mat-form-field class="search">
          <mat-label>Buscar producto</mat-label>
          <input matInput [(ngModel)]="search" (keyup.enter)="reload()" />
        </mat-form-field>
        <mat-slide-toggle [(ngModel)]="lowOnly" (change)="reload()">Solo stock bajo</mat-slide-toggle>
      </div>

      @if (totalValue() !== null) {
        <p class="vk-muted">Valor de esta página: <strong>{{ '$' + totalValue() }}</strong></p>
      }

      <div class="vk-table-wrap">
        <table class="t">
          <thead>
            <tr><th>Producto</th><th class="r">Existencia</th><th class="r">Mínimo</th>@if (showCosts()) { <th class="r">Costo prom.</th><th class="r">Valor</th> }</tr>
          </thead>
          <tbody>
            @for (s of rows(); track s.productId) {
              <tr class="row" (click)="kardex(s)">
                <td><span class="vk-mono small vk-muted">{{ s.code }}</span> {{ s.name }}</td>
                <td class="r strong" [class.low]="s.lowStock || +s.quantity < 0">{{ +s.quantity }} {{ s.unit }}</td>
                <td class="r vk-muted">{{ +s.minStock || '' }}</td>
                @if (showCosts()) { <td class="r">{{ s.avgCost }}</td><td class="r">{{ s.value }}</td> }
              </tr>
            } @empty {
              <tr><td colspan="5" class="vk-empty">Sin productos con inventario</td></tr>
            }
          </tbody>
        </table>
        <mat-paginator [length]="total()" [pageSize]="pageSize" [pageSizeOptions]="[50, 100, 200]" (page)="page($event)" />
      </div>
    </div>
  `,
  styles: `
    .filters { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
    .search { flex: 1; min-width: 220px; }
    .t { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
    .t th, .t td { padding: 10px 12px; border-bottom: 1px solid var(--mat-sys-outline-variant); text-align: left; }
    .t th { font: var(--mat-sys-label-medium); color: var(--vk-muted); }
    .r { text-align: right !important; } .strong { font-weight: 600; } .low { color: var(--vk-danger); } .small { font-size: 12px; }
    .row { cursor: pointer; } .row:hover { background: var(--mat-sys-surface-container-low); }
  `,
})
export class StockPage implements OnInit {
  private readonly api = inject(CatalogApi);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(Notify);
  protected readonly auth = inject(AuthService);
  protected readonly lk = signal<CatalogLookups | null>(null);
  protected readonly rows = signal<StockItem[]>([]);
  protected readonly total = signal(0);
  protected readonly showCosts = signal(false);
  protected readonly totalValue = signal<string | null>(null);
  protected warehouseId = '';
  protected search = '';
  protected lowOnly = false;
  protected pageSize = 50;
  private pageIndex = 0;

  async ngOnInit(): Promise<void> {
    this.lk.set(await this.api.lookups());
    await this.reload();
  }

  protected reload(): Promise<void> {
    this.pageIndex = 0;
    return this.fetch();
  }

  protected page(e: PageEvent): void {
    this.pageIndex = e.pageIndex;
    this.pageSize = e.pageSize;
    void this.fetch();
  }

  private async fetch(): Promise<void> {
    try {
      const r = await this.api.stock({ warehouseId: this.warehouseId, search: this.search, lowOnly: this.lowOnly || undefined, page: this.pageIndex + 1, pageSize: this.pageSize });
      this.rows.set(r.items);
      this.total.set(r.total);
      const costs = r.items.some((i) => i.avgCost !== null);
      this.showCosts.set(costs);
      this.totalValue.set(costs ? r.items.reduce((s, i) => s + Number(i.value ?? 0), 0).toFixed(2) : null);
    } catch (e) {
      this.notify.error(e);
    }
  }

  protected kardex(s: StockItem): void {
    this.dialog.open(KardexDialog, { data: { productId: s.productId, name: s.name, code: s.code }, width: 'min(980px, calc(100vw - 32px))', maxWidth: '100vw' });
  }

  protected movement(mode: 'adjust' | 'transfer'): void {
    this.dialog
      .open(MovementDialog, { data: { mode }, width: 'min(820px, calc(100vw - 32px))', maxWidth: '100vw' })
      .afterClosed()
      .subscribe((ok) => ok && this.fetch());
  }
}
