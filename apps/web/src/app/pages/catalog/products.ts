import { CurrencyPipe } from '@angular/common';
import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTableModule } from '@angular/material/table';
import { RouterLink } from '@angular/router';
import type { NamedItem, ProductListItem } from '@vektra/shared-contracts';
import { AuthService } from '../../core/auth.service';
import { Notify } from '../../core/notify.service';
import { KardexDialog } from '../inventory/kardex-dialog';
import { CatalogApi } from './catalog.api';
import { ProductDialog } from './product-dialog';

@Component({
  selector: 'vk-products',
  imports: [MatTableModule, MatPaginatorModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatSlideToggleModule, MatButtonModule, FormsModule, CurrencyPipe, RouterLink],
  template: `
    <div class="vk-page">
      <div class="vk-page-header">
        <div>
          <h1>Productos</h1>
          <p>Catálogo, precios por lista y existencias.</p>
        </div>
        <div class="vk-actions">
          @if (auth.can('catalog.manage')) {
            <a matButton="outlined" routerLink="/importar"><span class="material-symbols-outlined">upload_file</span> Importar Excel</a>
            <button matButton="filled" (click)="open(null)"><span class="material-symbols-outlined">add</span> Nuevo producto</button>
          }
        </div>
      </div>

      <div class="filters">
        <mat-form-field class="search">
          <mat-label>Buscar por nombre, código o código de barras</mat-label>
          <input matInput [(ngModel)]="search" (keyup.enter)="reload()" (ngModelChange)="debounced()" />
          <span class="material-symbols-outlined" matSuffix>search</span>
        </mat-form-field>
        <mat-form-field>
          <mat-label>Categoría</mat-label>
          <mat-select [(ngModel)]="categoryId" (selectionChange)="reload()">
            <mat-option [value]="''">Todas</mat-option>
            @for (c of categories(); track c.id) { <mat-option [value]="c.id">{{ c.name }}</mat-option> }
          </mat-select>
        </mat-form-field>
        <mat-slide-toggle [(ngModel)]="lowStock" (change)="reload()">Solo stock bajo</mat-slide-toggle>
      </div>

      <div class="vk-table-wrap">
        <table mat-table [dataSource]="rows()">
          <ng-container matColumnDef="name">
            <th mat-header-cell *matHeaderCellDef>Producto</th>
            <td mat-cell *matCellDef="let p">
              <div class="prod">
                @if (p.imageUrl && p.imageUrl !== 'embedded') { <img [src]="p.imageUrl" alt="" /> }
                <div>
                  <strong>{{ p.name }}</strong> @if (!p.active) { <span class="vk-badge">Inactivo</span> }
                  <div class="vk-muted small"><span class="vk-mono">{{ p.code }}</span> · {{ p.category ?? 'Sin categoría' }}{{ p.brand ? ' · ' + p.brand : '' }}</div>
                </div>
              </div>
            </td>
          </ng-container>
          <ng-container matColumnDef="tax">
            <th mat-header-cell *matHeaderCellDef>IVA</th>
            <td mat-cell *matCellDef="let p">{{ p.taxLabel }}</td>
          </ng-container>
          <ng-container matColumnDef="price">
            <th mat-header-cell *matHeaderCellDef class="r">PVP</th>
            <td mat-cell *matCellDef="let p" class="r num">
              @if (p.priceWithTax) { {{ p.priceWithTax | currency }} <div class="vk-muted small">sin IVA {{ p.price | currency }}</div> } @else { <span class="vk-muted">—</span> }
            </td>
          </ng-container>
          <ng-container matColumnDef="stock">
            <th mat-header-cell *matHeaderCellDef class="r">Stock</th>
            <td mat-cell *matCellDef="let p" class="r num">
              @if (p.isService) { <span class="vk-muted small">servicio</span> } @else {
                <span [class.low]="p.lowStock">{{ +p.stock }} {{ p.unit }}</span>
                @if (p.lowStock) { <div class="small low">bajo el mínimo ({{ +p.minStock }})</div> }
              }
            </td>
          </ng-container>
          <ng-container matColumnDef="cost">
            <th mat-header-cell *matHeaderCellDef class="r">Costo prom.</th>
            <td mat-cell *matCellDef="let p" class="r num vk-muted">{{ p.avgCost !== null ? '$' + p.avgCost : '' }}</td>
          </ng-container>
          <ng-container matColumnDef="actions">
            <th mat-header-cell *matHeaderCellDef></th>
            <td mat-cell *matCellDef="let p" class="r">
              @if (!p.isService && auth.can('inventory.read')) {
                <button matIconButton (click)="kardex(p); $event.stopPropagation()" aria-label="Ver kárdex"><span class="material-symbols-outlined">receipt</span></button>
              }
            </td>
          </ng-container>
          <tr mat-header-row *matHeaderRowDef="columns"></tr>
          <tr mat-row *matRowDef="let r; columns: columns" class="row" (click)="open(r.id)"></tr>
        </table>
        @if (!rows().length) { <div class="vk-empty">No hay productos. Créelos uno a uno o impórtelos desde Excel.</div> }
        <mat-paginator [length]="total()" [pageSize]="pageSize" [pageSizeOptions]="[25, 50, 100]" (page)="page($event)" />
      </div>
    </div>
  `,
  styles: `
    .filters { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
    .search { flex: 1; min-width: 260px; }
    .prod { display: flex; gap: 10px; align-items: center; }
    .prod img { width: 40px; height: 40px; border-radius: 8px; object-fit: cover; }
    .small { font: var(--mat-sys-body-small); }
    .r { text-align: right; }
    .num { font-variant-numeric: tabular-nums; }
    .low { color: var(--vk-danger); }
    .row { cursor: pointer; }
    .row:hover { background: var(--mat-sys-surface-container-low); }
  `,
})
export class ProductsPage implements OnInit {
  private readonly api = inject(CatalogApi);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(Notify);
  protected readonly auth = inject(AuthService);
  protected readonly rows = signal<ProductListItem[]>([]);
  protected readonly total = signal(0);
  protected readonly categories = signal<NamedItem[]>([]);
  protected readonly columns = ['name', 'tax', 'price', 'stock', ...(this.auth.can('catalog.costs') ? ['cost'] : []), 'actions'];
  protected search = '';
  protected categoryId = '';
  protected lowStock = false;
  protected pageSize = 25;
  private pageIndex = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  async ngOnInit(): Promise<void> {
    void this.reload();
    this.categories.set((await this.api.lookups()).categories);
  }

  protected debounced(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.reload(), 300);
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
      const r = await this.api.products({ search: this.search, categoryId: this.categoryId, lowStock: this.lowStock || undefined, page: this.pageIndex + 1, pageSize: this.pageSize });
      this.rows.set(r.items);
      this.total.set(r.total);
    } catch (e) {
      this.notify.error(e);
    }
  }

  protected open(id: string | null): void {
    if (!id && !this.auth.can('catalog.manage')) return;
    this.dialog
      .open(ProductDialog, { data: { id }, width: 'min(860px, calc(100vw - 32px))', maxWidth: '100vw' })
      .afterClosed()
      .subscribe((saved) => saved && this.fetch());
  }

  protected kardex(p: ProductListItem): void {
    this.dialog.open(KardexDialog, { data: { productId: p.id, name: p.name, code: p.code }, width: 'min(980px, calc(100vw - 32px))', maxWidth: '100vw' });
  }
}
