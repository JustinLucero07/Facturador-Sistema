import { DatePipe } from '@angular/common';
import { Component, inject, OnInit, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import type { KardexItem } from '@vektra/shared-contracts';
import { Notify } from '../../core/notify.service';
import { CatalogApi } from '../catalog/catalog.api';

@Component({
  selector: 'vk-kardex-dialog',
  imports: [MatDialogModule, MatButtonModule, MatPaginatorModule, DatePipe],
  template: `
    <h2 mat-dialog-title>Kárdex · <span class="vk-mono">{{ data.code }}</span> {{ data.name }}</h2>
    <mat-dialog-content>
      <table class="k">
        <thead>
          <tr>
            <th>Fecha</th><th>Movimiento</th><th>Bodega</th><th class="r">Cantidad</th>
            @if (showCosts()) { <th class="r">Costo unit.</th><th class="r">Total</th> }
            <th class="r">Saldo bodega</th>
            @if (showCosts()) { <th class="r">Costo prom.</th> }
            <th>Detalle</th>
          </tr>
        </thead>
        <tbody>
          @for (m of rows(); track m.id) {
            <tr>
              <td class="nowrap">{{ m.at | date: 'short' }}</td>
              <td>{{ m.typeLabel }}</td>
              <td>{{ m.warehouse }}</td>
              <td class="r" [class.in]="+m.quantity > 0" [class.out]="+m.quantity < 0">{{ +m.quantity > 0 ? '+' : '' }}{{ +m.quantity }}</td>
              @if (showCosts()) { <td class="r">{{ m.unitCost }}</td><td class="r">{{ m.totalCost }}</td> }
              <td class="r strong" [class.out]="+m.balanceAfter < 0">{{ +m.balanceAfter }}</td>
              @if (showCosts()) { <td class="r">{{ m.avgCostAfter }}</td> }
              <td class="vk-muted small">{{ m.reason }}{{ m.userName ? ' · ' + m.userName : '' }}</td>
            </tr>
          } @empty {
            <tr><td colspan="9" class="vk-empty">Sin movimientos</td></tr>
          }
        </tbody>
      </table>
      <mat-paginator [length]="total()" [pageSize]="50" [hidePageSize]="true" (page)="page($event)" />
    </mat-dialog-content>
    <mat-dialog-actions align="end"><button matButton mat-dialog-close>Cerrar</button></mat-dialog-actions>
  `,
  styles: `
    .k { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
    .k th, .k td { padding: 6px 8px; border-bottom: 1px solid var(--mat-sys-outline-variant); text-align: left; }
    .k th { font: var(--mat-sys-label-medium); color: var(--vk-muted); }
    .r { text-align: right !important; } .nowrap { white-space: nowrap; } .small { font: var(--mat-sys-body-small); }
    .in { color: var(--vk-success); } .out { color: var(--vk-danger); } .strong { font-weight: 600; }
  `,
})
export class KardexDialog implements OnInit {
  protected readonly data = inject<{ productId: string; name: string; code: string }>(MAT_DIALOG_DATA);
  private readonly api = inject(CatalogApi);
  private readonly notify = inject(Notify);
  protected readonly rows = signal<KardexItem[]>([]);
  protected readonly total = signal(0);
  protected readonly showCosts = signal(false);

  ngOnInit(): void {
    void this.load(1);
  }

  protected page(e: PageEvent): void {
    void this.load(e.pageIndex + 1);
  }

  private async load(page: number): Promise<void> {
    try {
      const r = await this.api.kardex(this.data.productId, { page, pageSize: 50 });
      this.rows.set(r.items);
      this.total.set(r.total);
      this.showCosts.set(r.items.some((i) => i.unitCost !== null));
    } catch (e) {
      this.notify.error(e);
    }
  }
}
