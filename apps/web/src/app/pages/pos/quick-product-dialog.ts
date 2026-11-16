import { Component, inject, OnInit, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import type { CatalogLookups, QuickProductRequest } from '@vektra/shared-contracts';
import { firstValueFrom } from 'rxjs';
import { Notify } from '../../core/notify.service';
import { CatalogApi } from '../catalog/catalog.api';

/** UUID v7 en el navegador (la caja de escritorio necesita los ids para vender sin conexión). */
function uuidv7(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let ts = Date.now();
  for (let i = 5; i >= 0; i--) {
    b[i] = ts & 0xff;
    ts = Math.floor(ts / 256);
  }
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Alta rápida desde la caja cuando un código escaneado no existe: código, nombre, IVA y PVP.
 * El resto de datos (categoría, costo, presentaciones) se completa luego en Productos.
 */
@Component({
  selector: 'vk-quick-product',
  imports: [ReactiveFormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule],
  template: `
    <h2 mat-dialog-title>Producto nuevo</h2>
    <mat-dialog-content>
      <p class="vk-muted hint">"{{ data.term }}" no existe en el catálogo. Créelo para venderlo ahora.</p>
      @if (lookups(); as lk) {
        <form [formGroup]="form" class="f" (ngSubmit)="save()">
          <mat-form-field>
            <mat-label>Código</mat-label>
            <input matInput formControlName="code" maxlength="25" />
          </mat-form-field>
          <mat-form-field>
            <mat-label>Código de barras</mat-label>
            <input matInput formControlName="barcode" maxlength="64" />
          </mat-form-field>
          <mat-form-field class="full">
            <mat-label>Nombre</mat-label>
            <input matInput formControlName="name" maxlength="300" cdkFocusInitial />
          </mat-form-field>
          <mat-form-field>
            <mat-label>IVA</mat-label>
            <mat-select formControlName="taxRateId">
              @for (r of lk.taxRates; track r.id) { <mat-option [value]="r.id">{{ r.label }}</mat-option> }
            </mat-select>
          </mat-form-field>
          <mat-form-field>
            <mat-label>Unidad</mat-label>
            <mat-select formControlName="unitId">
              @for (u of lk.units; track u.id) { <mat-option [value]="u.id">{{ u.name }}</mat-option> }
            </mat-select>
          </mat-form-field>
          <mat-form-field class="full">
            <mat-label>Precio de venta (PVP, con IVA)</mat-label>
            <span matTextPrefix>$&nbsp;</span>
            <input matInput formControlName="pvp" inputmode="decimal" />
            <mat-hint>Lista {{ defaultList() }}</mat-hint>
          </mat-form-field>
        </form>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancelar</button>
      <button matButton="filled" (click)="save()" [disabled]="busy() || !lookups()">Crear y agregar</button>
    </mat-dialog-actions>
  `,
  styles: `
    .hint { margin: 0 0 12px; }
    .f { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; width: min(520px, 80vw); }
    .full { grid-column: 1 / -1; }
    @media (max-width: 599px) { .f { grid-template-columns: 1fr; } }
  `,
})
export class QuickProductDialog implements OnInit {
  protected readonly data = inject<{ term: string }>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<QuickProductDialog, string>);
  private readonly catalog = inject(CatalogApi);
  private readonly http = inject(HttpClient);
  private readonly notify = inject(Notify);
  protected readonly lookups = signal<CatalogLookups | null>(null);
  protected readonly busy = signal(false);
  private readonly isBarcode = /^\d{8,14}$/.test(this.data.term);
  protected readonly form = new FormGroup({
    code: new FormControl(this.isBarcode ? '' : this.data.term.toUpperCase().slice(0, 25), { nonNullable: true, validators: [Validators.required] }),
    barcode: new FormControl(this.isBarcode ? this.data.term : '', { nonNullable: true }),
    name: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    taxRateId: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    unitId: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    pvp: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.pattern(/^\d+([.,]\d{1,4})?$/)] }),
  });

  protected defaultList(): string {
    return this.lookups()?.priceLists.find((p) => p.isDefault)?.name ?? '';
  }

  async ngOnInit(): Promise<void> {
    try {
      const lk = await this.catalog.lookups();
      this.lookups.set(lk);
      const iva = lk.taxRates.find((r) => r.percentageCode === '4') ?? lk.taxRates[0];
      const und = lk.units.find((u) => u.code === 'UND') ?? lk.units[0];
      this.form.patchValue({ taxRateId: iva?.id ?? '', unitId: und?.id ?? '' });
      if (this.isBarcode) this.form.patchValue({ code: this.data.term.slice(-25) });
    } catch (e) {
      this.notify.error(e);
    }
  }

  protected async save(): Promise<void> {
    const lk = this.lookups();
    if (!lk) return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return this.notify.error('Complete código, nombre, IVA, unidad y precio');
    }
    const v = this.form.getRawValue();
    const rate = Number(lk.taxRates.find((r) => r.id === v.taxRateId)?.rate ?? 0);
    const body: QuickProductRequest = {
      id: uuidv7(),
      productUnitId: uuidv7(),
      code: v.code.trim(),
      name: v.name.trim(),
      unitId: v.unitId,
      taxRateId: v.taxRateId,
      isService: false,
      barcode: v.barcode.trim() || null,
      price: (Number(v.pvp.replace(',', '.')) / (1 + rate / 100)).toFixed(6),
    };
    this.busy.set(true);
    try {
      await firstValueFrom(this.http.post('/api/products/quick', body));
      this.ref.close(v.barcode.trim() || body.code);
    } catch (e) {
      this.notify.error(e);
    } finally {
      this.busy.set(false);
    }
  }
}
