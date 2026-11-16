import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import type { CatalogLookups, ProductSearchItem } from '@vektra/shared-contracts';
import { Notify } from '../../core/notify.service';
import { ProductPicker } from '../../shared/product-picker';
import { CatalogApi } from '../catalog/catalog.api';

interface Item {
  productId: string;
  code: string;
  name: string;
  unit: string;
  stock: string | null;
  quantity: string;
  unitCost: string;
}

/** Ajuste de inventario (entrada/salida con motivo) o transferencia entre bodegas. */
@Component({
  selector: 'vk-movement-dialog',
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatButtonToggleModule, MatFormFieldModule, MatInputModule, MatSelectModule, ProductPicker],
  template: `
    <h2 mat-dialog-title>{{ mode === 'transfer' ? 'Transferencia entre bodegas' : 'Ajuste de inventario' }}</h2>
    <mat-dialog-content>
      @if (lk(); as lk) {
        <div class="vk-form-grid">
          @if (mode === 'adjust') {
            <div class="vk-full">
              <mat-button-toggle-group [(ngModel)]="direction" aria-label="Tipo de ajuste">
                <mat-button-toggle value="IN">Entrada (+)</mat-button-toggle>
                <mat-button-toggle value="OUT">Salida (−)</mat-button-toggle>
              </mat-button-toggle-group>
            </div>
          }
          <mat-form-field>
            <mat-label>{{ mode === 'transfer' ? 'Desde la bodega' : 'Bodega' }}</mat-label>
            <mat-select [(ngModel)]="warehouseId">
              @for (w of lk.warehouses; track w.id) { <mat-option [value]="w.id">{{ w.name }} · {{ w.establishment }}</mat-option> }
            </mat-select>
          </mat-form-field>
          @if (mode === 'transfer') {
            <mat-form-field>
              <mat-label>Hacia la bodega</mat-label>
              <mat-select [(ngModel)]="toWarehouseId">
                @for (w of lk.warehouses; track w.id) {
                  @if (w.id !== warehouseId) { <mat-option [value]="w.id">{{ w.name }} · {{ w.establishment }}</mat-option> }
                }
              </mat-select>
            </mat-form-field>
          }
          <mat-form-field [class.vk-full]="mode === 'adjust'">
            <mat-label>Motivo</mat-label>
            <input matInput [(ngModel)]="reason" [placeholder]="mode === 'adjust' ? 'Ej.: conteo físico, merma, producto dañado' : 'Opcional'" />
          </mat-form-field>
        </div>

        <vk-product-picker [warehouseId]="warehouseId" (picked)="add($event)" />

        <table class="items">
          <thead>
            <tr><th>Producto</th><th class="r">Stock</th><th class="r">Cantidad</th>@if (mode === 'adjust' && direction === 'IN') { <th class="r">Costo unit. (sin IVA)</th> }<th></th></tr>
          </thead>
          <tbody>
            @for (it of items(); track it.productId; let i = $index) {
              <tr>
                <td><span class="vk-mono small">{{ it.code }}</span> {{ it.name }}</td>
                <td class="r vk-muted">{{ it.stock !== null ? +it.stock : '' }} {{ it.unit }}</td>
                <td class="r"><input class="cell" [(ngModel)]="it.quantity" inputmode="decimal" /></td>
                @if (mode === 'adjust' && direction === 'IN') { <td class="r"><input class="cell" [(ngModel)]="it.unitCost" inputmode="decimal" placeholder="promedio" /></td> }
                <td><button matIconButton (click)="remove(i)" aria-label="Quitar"><span class="material-symbols-outlined">close</span></button></td>
              </tr>
            } @empty {
              <tr><td colspan="5" class="vk-empty">Busque y agregue productos</td></tr>
            }
          </tbody>
        </table>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancelar</button>
      <button matButton="filled" (click)="save()" [disabled]="saving() || !items().length">Registrar</button>
    </mat-dialog-actions>
  `,
  styles: `
    .items { width: 100%; border-collapse: collapse; margin-top: 8px; }
    .items th, .items td { border-bottom: 1px solid var(--mat-sys-outline-variant); padding: 6px; text-align: left; }
    .items th { font: var(--mat-sys-label-medium); color: var(--vk-muted); }
    .r { text-align: right !important; }
    .cell { width: 100px; padding: 8px; border: 1px solid var(--mat-sys-outline-variant); border-radius: 6px; text-align: right; font: inherit; background: var(--mat-sys-surface); color: inherit; }
    .small { font-size: 12px; }
  `,
})
export class MovementDialog implements OnInit {
  protected readonly mode = inject<{ mode: 'adjust' | 'transfer' }>(MAT_DIALOG_DATA).mode;
  private readonly api = inject(CatalogApi);
  private readonly notify = inject(Notify);
  private readonly ref = inject(MatDialogRef<MovementDialog>);
  protected readonly lk = signal<CatalogLookups | null>(null);
  protected readonly items = signal<Item[]>([]);
  protected readonly saving = signal(false);
  protected direction: 'IN' | 'OUT' = 'IN';
  protected warehouseId = '';
  protected toWarehouseId = '';
  protected reason = '';

  async ngOnInit(): Promise<void> {
    const lk = await this.api.lookups();
    this.lk.set(lk);
    this.warehouseId = lk.warehouses.find((w) => w.isDefault)?.id ?? lk.warehouses[0]?.id ?? '';
  }

  protected add(p: ProductSearchItem): void {
    if (p.isService) return this.notify.error('Los servicios no llevan inventario');
    if (this.items().some((i) => i.productId === p.id)) return;
    const base = p.units.find((u) => u.isBase);
    this.items.set([...this.items(), { productId: p.id, code: p.code, name: p.name, unit: base?.code ?? '', stock: p.stock, quantity: '1', unitCost: '' }]);
  }

  protected remove(i: number): void {
    this.items.set(this.items().filter((_, k) => k !== i));
  }

  protected async save(): Promise<void> {
    const items = this.items();
    if (items.some((i) => !/^\d+([.,]\d+)?$/.test(i.quantity) || Number(i.quantity.replace(',', '.')) <= 0)) return this.notify.error('Revise las cantidades');
    this.saving.set(true);
    try {
      if (this.mode === 'transfer') {
        if (!this.toWarehouseId) return this.notify.error('Elija la bodega de destino');
        await this.api.transfer({
          fromWarehouseId: this.warehouseId,
          toWarehouseId: this.toWarehouseId,
          reason: this.reason || null,
          items: items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
        });
        this.notify.ok('Transferencia registrada');
      } else {
        if (this.reason.trim().length < 3) return this.notify.error('Indique el motivo del ajuste');
        await this.api.adjust({
          warehouseId: this.warehouseId,
          direction: this.direction,
          reason: this.reason,
          items: items.map((i) => ({ productId: i.productId, quantity: i.quantity, unitCost: this.direction === 'IN' && i.unitCost ? i.unitCost : null })),
        });
        this.notify.ok('Ajuste registrado');
      }
      this.ref.close(true);
    } catch (e) {
      this.notify.error(e);
    } finally {
      this.saving.set(false);
    }
  }
}
