import { CurrencyPipe, DatePipe, formatCurrency } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, inject, input, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatSelectModule } from '@angular/material/select';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatTableModule } from '@angular/material/table';
import { RouterLink } from '@angular/router';
import { EDOC_STATUS_LABELS, type EDocStatusCode, type Paginated, type PurchaseAtsCatalogs, type PurchaseDetail, type PurchaseListItem, type WithholdingDraft } from '@vektra/shared-contracts';
import { WithholdingDialog } from './withholding-dialog';
import { firstValueFrom } from 'rxjs';
import { apiMessage } from '../../core/http';
import { Notify } from '../../core/notify.service';

const DOC: Record<string, string> = { '01': 'Factura', '02': 'Nota de venta', '03': 'Liquidación' };

@Component({
  selector: 'vk-purchase-detail',
  imports: [MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatCheckboxModule, FormsModule, CurrencyPipe, DatePipe, RouterLink],
  template: `
    @if (p(); as p) {
      <h2 mat-dialog-title>{{ doc[p.docType] }} {{ p.number }} · {{ p.supplierName }}</h2>
      <mat-dialog-content class="c">
        <p class="vk-muted">
          RUC {{ p.supplierIdentification }} · {{ p.issueDate | date: 'mediumDate' : 'UTC' }} · bodega {{ p.warehouse }}
          @if (p.authorization) { <br />Autorización <span class="vk-mono">{{ p.authorization }}</span> }
        </p>
        @if (p.status === 'VOID') { <div class="void">Anulada: {{ p.voidReason }}</div> }
        @if (p.payable && p.status !== 'VOID') {
          <p class="payable">
            @if (p.payable.status === 'PAID') { <span class="vk-badge ok">Pagada</span> }
            @else { <span class="vk-badge warn">Por pagar {{ p.payable.balance | currency }}</span> vence {{ p.payable.dueDate | date: 'mediumDate' : 'UTC' }} · <a routerLink="/cuentas/pagar" mat-dialog-close>Cuentas por pagar</a> }
          </p>
        }
        <table class="t">
          <thead><tr><th>Producto</th><th class="n">Cant.</th><th class="n">Costo</th><th class="n">Desc.</th><th>IVA</th><th class="n">Subtotal</th></tr></thead>
          <tbody>
            @for (l of p.items; track $index) {
              <tr>
                <td>{{ l.product ? l.product.code + ' · ' + l.product.name : l.description }}@if (!l.product) { <small class="vk-muted"> (sin inventario)</small> }</td>
                <td class="n">{{ +l.quantity }}</td>
                <td class="n">{{ +l.unitCost }}</td>
                <td class="n">{{ l.discount | currency }}</td>
                <td>{{ l.taxLabel }}</td>
                <td class="n">{{ l.subtotal | currency }}</td>
              </tr>
            }
          </tbody>
        </table>
        <div class="tot">
          @for (g of p.taxSummary; track $index) { <div><span>Subtotal {{ g.label }}</span><span>{{ g.base | currency }}</span></div> }
          <div><span>IVA</span><span>{{ p.totalTax | currency }}</span></div>
          <div class="b"><span>Total</span><span>{{ p.total | currency }}</span></div>
        </div>
        <h3 class="sec">Datos para el ATS</h3>
        @if (editAts()) {
          <div class="atsf">
            <mat-form-field>
              <mat-label>Sustento tributario</mat-label>
              <mat-select [(ngModel)]="sustentoCode">
                @for (s of cat()?.sustento ?? []; track s.code) { <mat-option [value]="s.code">{{ s.code }} · {{ s.description }}</mat-option> }
              </mat-select>
            </mat-form-field>
            <mat-form-field>
              <mat-label>Forma de pago (SRI)</mat-label>
              <mat-select [(ngModel)]="paymentCode">
                <mat-option [value]="null">Sin forma de pago</mat-option>
                @for (f of cat()?.paymentForms ?? []; track f.code) { <mat-option [value]="f.code">{{ f.code }} · {{ f.description }}</mat-option> }
              </mat-select>
            </mat-form-field>
            <mat-checkbox [(ngModel)]="relatedParty">El proveedor es parte relacionada</mat-checkbox>
            <div class="atsb">
              <button matButton type="button" (click)="editAts.set(false)">Cancelar</button>
              <button matButton="filled" type="button" (click)="saveAts()" [disabled]="busy()">Guardar</button>
            </div>
          </div>
        } @else {
          <div class="atsv">
            <span>Sustento: @if (p.sustentoCode) { <b>{{ p.sustentoCode }}</b> {{ label(cat()?.sustento, p.sustentoCode) }} } @else { <span class="danger">falta</span> }</span>
            <span>Forma de pago: @if (p.paymentCode) { <b>{{ p.paymentCode }}</b> {{ label(cat()?.paymentForms, p.paymentCode) }} } @else { — }</span>
            <span>Parte relacionada: {{ p.relatedParty ? 'Sí' : 'No' }}</span>
            @if (p.status !== 'VOID') { <button matButton type="button" (click)="startAts(p)"><span class="material-symbols-outlined">edit</span> Cambiar</button> }
          </div>
        }
        <h3 class="sec">Retención</h3>
        @for (w of withholdings(); track w.id) {
          <div class="wh">
            <a [routerLink]="['/facturacion/comprobantes', w.id]" mat-dialog-close class="vk-mono">{{ w.number }}</a>
            <span>{{ w.total | currency }}</span>
            <span class="vk-badge" [class.ok]="w.status === 'AUTHORIZED'" [class.danger]="w.status === 'NOT_AUTHORIZED' || w.status === 'RETURNED'">{{ statusLabel(w.status) }}</span>
          </div>
        } @empty {
          <p class="vk-muted">Sin comprobante de retención.</p>
        }
        @if (voiding()) {
          <mat-form-field class="w">
            <mat-label>Motivo de la anulación</mat-label>
            <input matInput [(ngModel)]="reason" maxlength="300" cdkFocusInitial />
            <mat-hint>Se descontará del stock lo que entró con esta compra</mat-hint>
          </mat-form-field>
        }
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        @if (p.status !== 'VOID' && !hasLiveWithholding()) {
          <button matButton="outlined" (click)="withhold()"><span class="material-symbols-outlined">receipt</span> Emitir retención</button>
        }
        @if (p.status !== 'VOID') {
          @if (!voiding()) {
            <button matButton (click)="voiding.set(true)" class="danger">Anular compra</button>
          } @else {
            <button matButton="filled" class="danger-f" (click)="confirmVoid()" [disabled]="busy()">Confirmar anulación</button>
          }
        }
        <button matButton mat-dialog-close>Cerrar</button>
      </mat-dialog-actions>
    }
  `,
  styles: `
    .c { width: min(760px, 86vw); }
    .t { width: 100%; border-collapse: collapse; margin: 8px 0; }
    .t th, .t td { padding: 6px; border-bottom: 1px solid var(--mat-sys-outline-variant); text-align: left; }
    .t th { font: var(--mat-sys-label-medium); color: var(--vk-muted); }
    .n { text-align: right !important; font-variant-numeric: tabular-nums; }
    .tot { margin-left: auto; width: 260px; font-variant-numeric: tabular-nums; }
    .tot div { display: flex; justify-content: space-between; padding: 2px 0; }
    .tot .b { font-weight: 700; font-size: 18px; }
    .void { background: var(--vk-danger-bg); color: var(--vk-danger); padding: 8px 12px; border-radius: 10px; }
    .w { width: 100%; margin-top: 12px; }
    .sec { font: var(--mat-sys-title-small); margin: 16px 0 6px; }
    .wh { display: flex; gap: 12px; align-items: center; padding: 4px 0; }
    .atsv { display: flex; flex-wrap: wrap; gap: 4px 18px; align-items: center; }
    .atsf { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
    .atsf mat-checkbox, .atsb { grid-column: 1 / -1; }
    .atsb { display: flex; justify-content: flex-end; gap: 8px; }
    .danger { color: var(--vk-danger); }
    .danger-f { --mat-button-filled-container-color: var(--vk-danger); }
  `,
})
export class PurchaseDetailDialog implements OnInit {
  private readonly data = inject<{ id: string }>(MAT_DIALOG_DATA);
  private readonly http = inject(HttpClient);
  private readonly notify = inject(Notify);
  private readonly ref = inject(MatDialogRef<PurchaseDetailDialog, boolean>);
  protected readonly doc = DOC;
  protected readonly p = signal<PurchaseDetail | null>(null);
  protected readonly voiding = signal(false);
  protected readonly withholdings = signal<WithholdingDraft['existing']>([]);
  private readonly dialog = inject(MatDialog);
  protected readonly statusLabel = (s: EDocStatusCode) => EDOC_STATUS_LABELS[s];
  protected readonly hasLiveWithholding = () => this.withholdings().some((w) => w.status !== 'NOT_AUTHORIZED' && w.status !== 'RETURNED');
  protected readonly busy = signal(false);
  protected reason = '';
  protected readonly editAts = signal(false);
  protected readonly cat = signal<PurchaseAtsCatalogs | null>(null);
  protected sustentoCode: string | null = null;
  protected paymentCode: string | null = null;
  protected relatedParty = false;
  protected readonly label = (list: { code: string; description: string }[] | undefined, code: string) => list?.find((x) => x.code === code)?.description ?? '';

  protected startAts(p: PurchaseDetail): void {
    this.sustentoCode = p.sustentoCode;
    this.paymentCode = p.paymentCode;
    this.relatedParty = p.relatedParty;
    this.editAts.set(true);
  }

  protected async saveAts(): Promise<void> {
    if (!this.sustentoCode) return this.notify.error('Elija el sustento tributario');
    this.busy.set(true);
    try {
      await firstValueFrom(this.http.post(`/api/purchases/${this.data.id}/ats`, { sustentoCode: this.sustentoCode, paymentCode: this.paymentCode, relatedParty: this.relatedParty }));
      this.p.set(await firstValueFrom(this.http.get<PurchaseDetail>(`/api/purchases/${this.data.id}`)));
      this.editAts.set(false);
      this.notify.ok('Datos del ATS actualizados');
    } catch (e) {
      this.notify.error(apiMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  async ngOnInit(): Promise<void> {
    firstValueFrom(this.http.get<PurchaseAtsCatalogs>('/api/purchases/ats-catalogs'))
      .then((c) => this.cat.set(c))
      .catch(() => undefined);
    try {
      this.p.set(await firstValueFrom(this.http.get<PurchaseDetail>(`/api/purchases/${this.data.id}`)));
      await this.loadWithholdings();
    } catch (e) {
      this.notify.error(e);
    }
  }

  private async loadWithholdings(): Promise<void> {
    const d = await firstValueFrom(this.http.get<WithholdingDraft>(`/api/einvoice/purchases/${this.data.id}/withholding-draft`));
    this.withholdings.set(d.existing);
  }

  protected async withhold(): Promise<void> {
    const res = await firstValueFrom(this.dialog.open(WithholdingDialog, { data: { purchaseId: this.data.id }, maxWidth: '96vw' }).afterClosed());
    if (!res) return;
    this.notify.ok(`Retención ${res.number} por ${formatCurrency(Number(res.total), 'es-EC', '$', 'USD')} emitida; se envía al SRI y al proveedor`);
    await this.loadWithholdings();
  }

  protected async confirmVoid(): Promise<void> {
    if (this.reason.trim().length < 3) return this.notify.error('Indique el motivo');
    this.busy.set(true);
    try {
      await firstValueFrom(this.http.post(`/api/purchases/${this.data.id}/void`, { reason: this.reason.trim() }));
      this.notify.ok('Compra anulada');
      this.ref.close(true);
    } catch (e) {
      this.notify.error(apiMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}

@Component({
  selector: 'vk-purchases',
  imports: [MatTableModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatPaginatorModule, FormsModule, RouterLink, CurrencyPipe, DatePipe],
  template: `
    <div class="vk-page">
      <div class="vk-page-header">
        <div>
          <h1>Compras</h1>
          <p>Facturas de proveedores: suman stock y actualizan el costo promedio.</p>
        </div>
        <a matButton="filled" routerLink="/compras/nueva"><span class="material-symbols-outlined">add</span> Nueva compra</a>
      </div>
      <mat-form-field class="search">
        <mat-label>Buscar por número, proveedor o RUC</mat-label>
        <input matInput [(ngModel)]="search" (keyup.enter)="reload()" />
        <span class="material-symbols-outlined" matSuffix>search</span>
      </mat-form-field>
      <div class="vk-table-wrap">
        <table mat-table [dataSource]="rows()">
          <ng-container matColumnDef="number">
            <th mat-header-cell *matHeaderCellDef>Comprobante</th>
            <td mat-cell *matCellDef="let r">
              <span class="vk-mono">{{ r.number }}</span>
              <div class="vk-muted small">{{ doc[r.docType] }} · {{ r.issueDate | date: 'mediumDate' : 'UTC' }}</div>
            </td>
          </ng-container>
          <ng-container matColumnDef="supplier">
            <th mat-header-cell *matHeaderCellDef>Proveedor</th>
            <td mat-cell *matCellDef="let r">{{ r.supplierName }}<div class="vk-muted small">{{ r.supplierIdentification }}</div></td>
          </ng-container>
          <ng-container matColumnDef="total">
            <th mat-header-cell *matHeaderCellDef class="n">Total</th>
            <td mat-cell *matCellDef="let r" class="n">{{ r.total | currency }}</td>
          </ng-container>
          <ng-container matColumnDef="status">
            <th mat-header-cell *matHeaderCellDef>Estado</th>
            <td mat-cell *matCellDef="let r">
              @if (r.status === 'VOID') { <span class="vk-badge danger">Anulada</span> } @else { <span class="vk-badge ok">Registrada</span> }
              @if (r.fromXml) { <span class="vk-badge brand">XML</span> }
            </td>
          </ng-container>
          <tr mat-header-row *matHeaderRowDef="cols"></tr>
          <tr mat-row *matRowDef="let row; columns: cols" class="click" (click)="open(row.id)"></tr>
          <tr class="mat-row" *matNoDataRow><td class="mat-cell vk-muted empty" [attr.colspan]="cols.length">Sin compras registradas.</td></tr>
        </table>
        <mat-paginator [length]="total()" [pageSize]="pageSize" [pageIndex]="page - 1" (page)="paginate($event)" [pageSizeOptions]="[20, 50]" />
      </div>
    </div>
  `,
  styles: `
    .search { width: min(420px, 100%); }
    .small { font: var(--mat-sys-body-small); }
    .n { text-align: right; }
    .click { cursor: pointer; }
    .vk-badge + .vk-badge { margin-left: 4px; }
    .empty { padding: 24px 16px; }
  `,
})
export class PurchasesPage implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(Notify);
  /** ?ver=<id>: abrir el detalle al volver de registrar */
  readonly ver = input<string | undefined>();
  protected readonly doc = DOC;
  protected readonly rows = signal<PurchaseListItem[]>([]);
  protected readonly total = signal(0);
  protected readonly cols = ['number', 'supplier', 'total', 'status'];
  protected search = '';
  protected page = 1;
  protected pageSize = 20;

  async ngOnInit(): Promise<void> {
    await this.reload();
    const v = this.ver();
    if (v) this.open(v);
  }

  protected async reload(): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.http.get<Paginated<PurchaseListItem>>('/api/purchases', { params: { page: this.page, pageSize: this.pageSize, ...(this.search.trim() ? { search: this.search.trim() } : {}) } }),
      );
      this.rows.set(res.items);
      this.total.set(res.total);
    } catch (e) {
      this.notify.error(e);
    }
  }

  protected paginate(e: PageEvent): void {
    this.page = e.pageIndex + 1;
    this.pageSize = e.pageSize;
    void this.reload();
  }

  protected open(id: string): void {
    this.dialog
      .open(PurchaseDetailDialog, { data: { id }, maxWidth: '96vw' })
      .afterClosed()
      .subscribe((changed) => changed && void this.reload());
  }
}
