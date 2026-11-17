import { CurrencyPipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { Router, RouterLink } from '@angular/router';
import type { CatalogLookups, ProductSearchItem, PurchaseRequest, PurchaseXmlPreview } from '@vektra/shared-contracts';
import { computeInvoice } from '@vektra/sri-core/calc';
import { firstValueFrom } from 'rxjs';
import { apiMessage } from '../../core/http';
import { Notify } from '../../core/notify.service';
import { ProductPicker } from '../../shared/product-picker';
import { CatalogApi } from '../catalog/catalog.api';

interface Line {
  key: number;
  productId: string | null;
  productUnitId: string | null;
  productLabel: string | null;
  supplierCode: string | null;
  description: string;
  quantity: string;
  unitCost: string;
  discount: string;
  taxRateId: string;
  /** Línea del XML aún sin producto elegido */
  needsProduct: boolean;
}

let seq = 0;

/** Registrar una compra: a mano o cargando el XML autorizado de la factura del proveedor. */
@Component({
  selector: 'vk-purchase-form',
  imports: [FormsModule, MatButtonModule, MatCheckboxModule, MatFormFieldModule, MatInputModule, MatSelectModule, CurrencyPipe, RouterLink, ProductPicker],
  template: `
    <div class="vk-page">
      <a routerLink="/compras" class="back"><span class="material-symbols-outlined">arrow_back</span> Compras</a>
      <div class="vk-page-header">
        <div>
          <h1>Nueva compra</h1>
          <p>Suma el stock y actualiza el costo promedio de cada producto. Cargue el XML de la factura del proveedor para llenarla sola.</p>
        </div>
        <div class="vk-actions">
          <input #file type="file" accept=".xml,text/xml,application/xml" hidden (change)="loadXml($event)" />
          <button matButton="outlined" (click)="file.click()"><span class="material-symbols-outlined">upload_file</span> Cargar XML del proveedor</button>
        </div>
      </div>

      @if (warnings().length) {
        <div class="warn">@for (w of warnings(); track w) { <div>{{ w }}</div> }</div>
      }

      <section class="vk-card head">
        <mat-form-field>
          <mat-label>RUC / cédula del proveedor</mat-label>
          <input matInput [(ngModel)]="supplierIdent" (blur)="findSupplier()" (keydown.enter)="findSupplier()" inputmode="numeric" maxlength="20" />
          @if (supplierId()) { <mat-hint class="ok">Proveedor registrado</mat-hint> } @else if (supplierIdent) { <mat-hint>Proveedor nuevo: se registrará con la compra</mat-hint> }
        </mat-form-field>
        <mat-form-field class="wide">
          <mat-label>Nombre o razón social</mat-label>
          <input matInput [(ngModel)]="supplierName" [readonly]="!!supplierId()" maxlength="300" />
        </mat-form-field>
        <mat-form-field>
          <mat-label>Comprobante</mat-label>
          <mat-select [(ngModel)]="docType">
            <mat-option value="01">Factura</mat-option>
            <mat-option value="02">Nota de venta</mat-option>
            <mat-option value="03">Liquidación de compra</mat-option>
          </mat-select>
        </mat-form-field>
        <mat-form-field>
          <mat-label>Número</mat-label>
          <input matInput [(ngModel)]="number" placeholder="001-001-000000123" maxlength="17" />
        </mat-form-field>
        <mat-form-field>
          <mat-label>Fecha de emisión</mat-label>
          <input matInput type="date" [(ngModel)]="issueDate" />
        </mat-form-field>
        <mat-form-field class="wide">
          <mat-label>Autorización / clave de acceso</mat-label>
          <input matInput [(ngModel)]="authorization" inputmode="numeric" maxlength="49" />
        </mat-form-field>
        <mat-form-field>
          <mat-label>Bodega</mat-label>
          <mat-select [(ngModel)]="warehouseId">
            @for (w of lookups()?.warehouses ?? []; track w.id) { <mat-option [value]="w.id">{{ w.name }} ({{ w.establishment }})</mat-option> }
          </mat-select>
        </mat-form-field>
      </section>

      <section class="vk-card">
        <div class="picker"><vk-product-picker label="Agregar producto (código, nombre o código de barras)" (picked)="add($event)" /></div>
        <div class="lines">
          <div class="row hdr"><span>Producto</span><span class="n">Cantidad</span><span class="n">Costo unit. sin IVA</span><span class="n">Descuento</span><span>IVA</span><span class="n">Subtotal</span><span></span></div>
          @for (l of lines(); track l.key; let k = $index) {
            <div class="row" [class.pending]="l.needsProduct">
              <span class="prod">
                @if (l.productLabel) {
                  <strong>{{ l.productLabel }}</strong>
                  @if (l.supplierCode) { <small class="vk-muted"> · cód. proveedor {{ l.supplierCode }}</small> }
                  <div class="vk-muted small">{{ l.description }}</div>
                } @else {
                  <input class="txt" [(ngModel)]="l.description" (ngModelChange)="touch()" aria-label="Descripción" />
                  @if (l.needsProduct) {
                    <div class="assign">
                      <vk-product-picker label="¿Qué producto es? (vacío = sin inventario)" (picked)="assign(k, $event)" />
                    </div>
                  }
                }
              </span>
              <input class="n" [(ngModel)]="l.quantity" (ngModelChange)="touch()" inputmode="decimal" aria-label="Cantidad" />
              <input class="n" [(ngModel)]="l.unitCost" (ngModelChange)="touch()" inputmode="decimal" aria-label="Costo unitario" />
              <input class="n" [(ngModel)]="l.discount" (ngModelChange)="touch()" inputmode="decimal" aria-label="Descuento" />
              <select [(ngModel)]="l.taxRateId" (ngModelChange)="touch()" aria-label="IVA">
                @for (r of lookups()?.taxRates ?? []; track r.id) { <option [value]="r.id">{{ r.label }}</option> }
              </select>
              <span class="n">{{ lineSubtotal(l) | currency }}</span>
              <button matIconButton (click)="remove(k)" aria-label="Quitar"><span class="material-symbols-outlined">close</span></button>
            </div>
          } @empty {
            <p class="vk-muted empty">Agregue productos o cargue el XML del proveedor.</p>
          }
        </div>
      </section>

      <section class="foot">
        <div class="opts">
          <div class="pay" role="radiogroup" aria-label="Forma de pago de la compra">
            <label><input type="radio" name="paymode" value="CREDIT" [(ngModel)]="paymentMode" /> A crédito</label>
            <label><input type="radio" name="paymode" value="CASH" [(ngModel)]="paymentMode" /> Al contado</label>
            @if (paymentMode === 'CREDIT') {
              <mat-form-field class="due">
                <mat-label>Vence (vacío = días de crédito del proveedor)</mat-label>
                <input matInput type="date" [(ngModel)]="dueDate" />
              </mat-form-field>
            } @else {
              <mat-form-field class="due">
                <mat-label>Pagada con</mat-label>
                <mat-select [(ngModel)]="payMethod">
                  <mat-option value="transferencia">Transferencia</mat-option>
                  <mat-option value="efectivo">Efectivo (no sale de la caja del POS)</mat-option>
                  <mat-option value="tarjeta_credito">Tarjeta de crédito</mat-option>
                  <mat-option value="tarjeta_debito">Tarjeta de débito</mat-option>
                </mat-select>
              </mat-form-field>
            }
          </div>
          <mat-checkbox [(ngModel)]="rememberCodes">Recordar los códigos del proveedor para la próxima carga de XML</mat-checkbox>
          <mat-form-field class="notes">
            <mat-label>Observaciones</mat-label>
            <input matInput [(ngModel)]="notes" maxlength="1000" />
          </mat-form-field>
        </div>
        <div class="vk-card totals">
          @if (totals(); as t) {
            @for (g of t.taxGroups; track g.percentageCode) { <div class="r"><span>Subtotal {{ +g.rate }}%</span><span>{{ g.base | currency }}</span></div> }
            @if (+t.totalDiscount > 0) { <div class="r"><span>Descuento</span><span>{{ t.totalDiscount | currency }}</span></div> }
            <div class="r"><span>IVA</span><span>{{ t.totalTax | currency }}</span></div>
            <div class="r big"><span>Total</span><span>{{ t.total | currency }}</span></div>
            @if (xmlTotal() && xmlTotal() !== t.total) { <div class="mismatch">El XML del proveedor suma {{ xmlTotal() | currency }}: revise las líneas.</div> }
          } @else {
            <div class="r big"><span>Total</span><span>$0,00</span></div>
          }
          <button matButton="filled" class="save" (click)="save()" [disabled]="busy() || !lines().length">{{ busy() ? 'Registrando…' : 'Registrar compra' }}</button>
        </div>
      </section>
    </div>
  `,
  styles: `
    .back { display: inline-flex; align-items: center; gap: 4px; color: var(--mat-sys-primary); text-decoration: none; margin-bottom: 8px; }
    .warn { background: var(--vk-warn-bg); color: var(--vk-warn); padding: 12px 16px; border-radius: 12px; margin-bottom: 16px; }
    .head { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0 12px; padding: 16px; margin-bottom: 16px; }
    .wide { grid-column: span 2; }
    .ok { color: var(--vk-success); }
    .picker { padding: 16px 16px 0; }
    .lines { padding: 8px 16px 16px; overflow-x: auto; }
    .row { display: grid; grid-template-columns: minmax(220px, 1fr) 90px 120px 90px 110px 100px 40px; gap: 8px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--mat-sys-outline-variant); min-width: 820px; }
    .row.hdr { font: var(--mat-sys-label-medium); color: var(--vk-muted); }
    .row.pending { background: var(--vk-warn-bg); border-radius: 8px; padding: 8px; }
    .row input, .row select { width: 100%; box-sizing: border-box; padding: 7px 8px; border-radius: 8px; border: 1px solid var(--mat-sys-outline-variant); font: inherit; background: var(--mat-sys-surface); color: inherit; }
    .n { text-align: right; font-variant-numeric: tabular-nums; }
    .small { font: var(--mat-sys-body-small); }
    .assign { margin-top: 6px; }
    .empty { padding: 16px 0; }
    .foot { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 16px; margin-top: 16px; align-items: start; }
    .opts { display: flex; flex-direction: column; gap: 12px; }
    .notes { width: 100%; }
    .pay { display: flex; flex-wrap: wrap; gap: 8px 20px; align-items: center; }
    .pay label { display: inline-flex; gap: 6px; align-items: center; cursor: pointer; }
    .due { width: min(320px, 100%); }
    .totals { padding: 16px; font-variant-numeric: tabular-nums; }
    .r { display: flex; justify-content: space-between; padding: 3px 0; color: var(--vk-muted); }
    .r.big { color: inherit; font: 700 22px/1.4 inherit; font-family: inherit; }
    .mismatch { color: var(--vk-danger); font: var(--mat-sys-body-small); margin-top: 6px; }
    .save { width: 100%; min-height: 48px; margin-top: 12px; }
    @media (max-width: 959px) { .head { grid-template-columns: 1fr 1fr; } .foot { grid-template-columns: 1fr; } }
    @media (max-width: 599px) { .head { grid-template-columns: 1fr; } .wide { grid-column: auto; } }
  `,
})
export class PurchaseFormPage implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly catalog = inject(CatalogApi);
  private readonly notify = inject(Notify);
  private readonly router = inject(Router);
  protected readonly lookups = signal<CatalogLookups | null>(null);
  protected readonly lines = signal<Line[]>([]);
  protected readonly supplierId = signal<string | null>(null);
  protected readonly warnings = signal<string[]>([]);
  protected readonly xmlTotal = signal<string | null>(null);
  protected readonly busy = signal(false);
  private readonly version = signal(0);
  protected supplierIdent = '';
  protected supplierName = '';
  protected docType: '01' | '02' | '03' = '01';
  protected number = '';
  protected issueDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
  protected authorization = '';
  protected warehouseId = '';
  protected notes = '';
  protected rememberCodes = true;
  protected paymentMode: 'CREDIT' | 'CASH' = 'CREDIT';
  protected payMethod = 'transferencia';
  protected dueDate = '';
  private fromXml = false;

  protected readonly totals = computed(() => {
    this.version();
    const lk = this.lookups();
    const ls = this.lines();
    if (!lk || !ls.length) return null;
    try {
      return computeInvoice(
        ls.map((l) => {
          const r = lk.taxRates.find((x) => x.id === l.taxRateId);
          return { description: l.description || '-', quantity: l.quantity || '0', unitPrice: l.unitCost || '0', discount: l.discount || '0', taxes: [{ taxCode: '2', percentageCode: r?.percentageCode ?? '0', rate: r?.rate ?? '0' }] };
        }),
      ).totals;
    } catch {
      return null;
    }
  });

  async ngOnInit(): Promise<void> {
    const lk = await this.catalog.lookups();
    this.lookups.set(lk);
    this.warehouseId = lk.warehouses.find((w) => w.isDefault)?.id ?? lk.warehouses[0]?.id ?? '';
  }

  protected touch(): void {
    this.version.update((v) => v + 1);
  }

  protected lineSubtotal(l: Line): string {
    const v = Number(l.quantity || 0) * Number(l.unitCost || 0) - Number(l.discount || 0);
    return Number.isFinite(v) ? v.toFixed(2) : '0';
  }

  private defaultRate(): string {
    const lk = this.lookups();
    return lk?.taxRates.find((r) => r.percentageCode === '4')?.id ?? lk?.taxRates[0]?.id ?? '';
  }

  protected add(p: ProductSearchItem): void {
    const unit = p.units.find((u) => u.productUnitId === p.matchedUnitId) ?? p.units.find((u) => u.isBase) ?? p.units[0];
    this.lines.update((ls) => [
      ...ls,
      {
        key: ++seq,
        productId: p.id,
        productUnitId: unit && !unit.isBase ? unit.productUnitId : null,
        productLabel: `${p.code} · ${p.name}${unit && !unit.isBase ? ` (${unit.name} x${+unit.factor})` : ''}`,
        supplierCode: null,
        description: p.name,
        quantity: '1',
        unitCost: '',
        discount: '0',
        taxRateId: p.taxRateId,
        needsProduct: false,
      },
    ]);
  }

  protected assign(k: number, p: ProductSearchItem): void {
    this.lines.update((ls) =>
      ls.map((l, i) => (i === k ? { ...l, productId: p.id, productUnitId: null, productLabel: `${p.code} · ${p.name}`, needsProduct: false } : l)),
    );
  }

  protected remove(k: number): void {
    this.lines.update((ls) => ls.filter((_, i) => i !== k));
  }

  protected async findSupplier(): Promise<void> {
    const id = this.supplierIdent.trim();
    if (!id) return;
    const p = await this.catalog.partyByIdentification(id).catch(() => null);
    this.supplierId.set(p?.id ?? null);
    if (p) this.supplierName = p.name;
  }

  protected async loadXml(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      const x = await firstValueFrom(this.http.post<PurchaseXmlPreview>('/api/purchases/xml-preview', fd));
      this.fromXml = true;
      this.supplierIdent = x.supplier.identification;
      this.supplierName = x.supplier.name;
      this.supplierId.set(x.supplier.id);
      this.docType = '01';
      this.number = x.number;
      this.authorization = x.authorization;
      this.issueDate = x.issueDate;
      this.xmlTotal.set(x.totals.total);
      this.lines.set(
        x.lines.map((l) => ({
          key: ++seq,
          productId: l.match?.productId ?? null,
          productUnitId: l.match?.productUnitId ?? null,
          productLabel: l.match ? `${l.match.code} · ${l.match.name}` : null,
          supplierCode: l.supplierCode,
          description: l.description,
          quantity: l.quantity,
          unitCost: l.unitCost,
          discount: l.discount,
          taxRateId: l.taxRateId ?? this.defaultRate(),
          needsProduct: !l.match,
        })),
      );
      const w: string[] = [];
      if (x.duplicate) w.push(`La factura ${x.number} de este proveedor ya está registrada.`);
      if (x.buyerMismatch) w.push(x.buyerMismatch);
      const pending = x.lines.filter((l) => !l.match).length;
      if (pending) w.push(`${pending} línea(s) no se relacionaron con un producto: elíjalo en cada una o déjela sin inventario.`);
      this.warnings.set(w);
      this.notify.ok(`XML cargado: ${x.lines.length} línea(s)`);
    } catch (e) {
      this.notify.error(apiMessage(e));
    }
  }

  protected async save(): Promise<void> {
    if (!this.supplierIdent.trim() || !this.supplierName.trim()) return this.notify.error('Ingrese el RUC o cédula y el nombre del proveedor');
    const idType = this.supplierIdent.trim().length === 13 ? '04' : this.supplierIdent.trim().length === 10 ? '05' : '06';
    const body: PurchaseRequest = {
      supplierId: this.supplierId(),
      newSupplier: this.supplierId() ? null : { idType, identification: this.supplierIdent.trim(), name: this.supplierName.trim() },
      docType: this.docType,
      number: this.number.trim(),
      authorization: this.authorization.trim() || null,
      issueDate: this.issueDate,
      warehouseId: this.warehouseId,
      notes: this.notes.trim() || null,
      fromXml: this.fromXml,
      rememberCodes: this.rememberCodes,
      payment: this.paymentMode === 'CASH' ? { mode: 'CASH', method: this.payMethod } : { mode: 'CREDIT', dueDate: this.dueDate || null },
      lines: this.lines().map((l) => ({
        productId: l.productId,
        productUnitId: l.productUnitId,
        supplierCode: l.supplierCode,
        description: l.description,
        quantity: l.quantity,
        unitCost: l.unitCost || '0',
        discount: l.discount || '0',
        taxRateId: l.taxRateId,
      })),
    };
    this.busy.set(true);
    try {
      const res = await firstValueFrom(this.http.post<{ id: string }>('/api/purchases', body));
      this.notify.ok('Compra registrada: el stock y los costos se actualizaron');
      await this.router.navigate(['/compras'], { queryParams: { ver: res.id } });
    } catch (e) {
      this.notify.error(apiMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
