import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatChipsModule } from '@angular/material/chips';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTabsModule } from '@angular/material/tabs';
import type { CatalogLookups, ProductRequest } from '@vektra/shared-contracts';
import { apiFields } from '../../core/http';
import { Notify } from '../../core/notify.service';
import { CatalogApi, withoutTax, withTax } from './catalog.api';

interface Presentation {
  unitId: string;
  factor: string;
  barcodes: string[];
}

@Component({
  selector: 'vk-product-dialog',
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatButtonToggleModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatSlideToggleModule, MatTabsModule, MatChipsModule],
  templateUrl: './product-dialog.html',
  styleUrl: './product-dialog.scss',
})
export class ProductDialog implements OnInit {
  private readonly api = inject(CatalogApi);
  private readonly notify = inject(Notify);
  private readonly ref = inject(MatDialogRef<ProductDialog>);
  protected readonly productId = inject<{ id: string | null }>(MAT_DIALOG_DATA).id;

  protected readonly lk = signal<CatalogLookups | null>(null);
  protected readonly saving = signal(false);
  protected readonly errors = signal<Record<string, string>>({});
  protected readonly stock = signal<{ warehouse: string; quantity: string }[]>([]);
  protected readonly avgCost = signal<string | null>(null);

  // Modelo del formulario
  protected code = '';
  protected name = '';
  protected description = '';
  protected categoryId: string | null = null;
  protected brandId: string | null = null;
  protected unitId = '';
  protected taxRateId = '';
  protected auxCode = '';
  protected isService = false;
  protected minStock = '0';
  protected imageUrl: string | null = null;
  protected active = true;
  protected barcodes: string[] = [];
  protected presentations: Presentation[] = [];
  /** Precios sin IVA: clave `${priceListId}|${unitId}` */
  protected prices: Record<string, string> = {};
  /** Ingreso de precios con IVA (PVP) */
  protected pricesWithTax = true;

  protected readonly rate = computed(() => this.lk()?.taxRates.find((t) => t.id === this.taxRateIdSig())?.rate ?? '0');
  private readonly taxRateIdSig = signal('');

  async ngOnInit(): Promise<void> {
    const lk = await this.api.lookups(true);
    this.lk.set(lk);
    if (this.productId) {
      const p = await this.api.product(this.productId);
      Object.assign(this, {
        code: p.code,
        name: p.name,
        description: p.description ?? '',
        categoryId: p.categoryId ?? null,
        brandId: p.brandId ?? null,
        unitId: p.unitId,
        taxRateId: p.taxRateId,
        auxCode: p.auxCode ?? '',
        isService: p.isService,
        minStock: p.minStock,
        imageUrl: p.imageUrl ?? null,
        active: p.active,
        barcodes: [...p.barcodes],
        presentations: p.units.map((u) => ({ ...u, barcodes: [...u.barcodes] })),
      });
      for (const pr of p.prices) this.prices[`${pr.priceListId}|${pr.unitId}`] = pr.price;
      this.stock.set(p.stock);
      this.avgCost.set(p.avgCost);
    } else {
      this.unitId = lk.units.find((u) => u.code === 'UND')?.id ?? lk.units[0]?.id ?? '';
      this.taxRateId = lk.taxRates.find((t) => t.percentageCode === '4')?.id ?? lk.taxRates[0]?.id ?? '';
    }
    this.taxRateIdSig.set(this.taxRateId);
  }

  protected onTaxChange(id: string): void {
    this.taxRateId = id;
    this.taxRateIdSig.set(id);
  }

  protected unitName(id: string): string {
    const u = this.lk()?.units.find((x) => x.id === id);
    return u ? `${u.name} (${u.code})` : '';
  }

  protected priceUnits(): string[] {
    return [this.unitId, ...this.presentations.map((p) => p.unitId).filter(Boolean)];
  }

  protected shownPrice(listId: string, unitId: string): string {
    const net = this.prices[`${listId}|${unitId}`];
    if (!net) return '';
    return this.pricesWithTax ? withTax(net, this.rate()) : String(Number(net));
  }

  protected setPrice(listId: string, unitId: string, value: string): void {
    const v = value.replace(',', '.').trim();
    const key = `${listId}|${unitId}`;
    if (!v) delete this.prices[key];
    else if (/^\d+(\.\d+)?$/.test(v)) this.prices[key] = this.pricesWithTax ? withoutTax(v, this.rate()) : v;
  }

  protected addBarcode(list: string[], ev: { value: string; chipInput: { clear(): void } }): void {
    const v = (ev.value ?? '').trim();
    if (v && !list.includes(v)) list.push(v);
    ev.chipInput.clear();
  }

  protected removeFrom(list: string[], v: string): void {
    const i = list.indexOf(v);
    if (i >= 0) list.splice(i, 1);
  }

  protected addPresentation(): void {
    this.presentations.push({ unitId: '', factor: '', barcodes: [] });
  }

  protected removePresentation(i: number): void {
    const [p] = this.presentations.splice(i, 1);
    for (const k of Object.keys(this.prices)) if (k.endsWith(`|${p.unitId}`)) delete this.prices[k];
  }

  /** Imagen reducida a 400 px (JPEG) para no cargar la base de datos. */
  protected async pickImage(ev: Event): Promise<void> {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 400 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d')?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    this.imageUrl = canvas.toDataURL('image/jpeg', 0.82);
  }

  protected async save(): Promise<void> {
    const body: ProductRequest = {
      code: this.code.trim(),
      name: this.name.trim(),
      description: this.description || null,
      categoryId: this.categoryId,
      brandId: this.brandId,
      unitId: this.unitId,
      taxRateId: this.taxRateId,
      auxCode: this.auxCode || null,
      isService: this.isService,
      minStock: this.minStock || '0',
      imageUrl: this.imageUrl,
      active: this.active,
      barcodes: this.barcodes,
      units: this.presentations.filter((p) => p.unitId && p.factor).map((p) => ({ unitId: p.unitId, factor: p.factor.replace(',', '.'), barcodes: p.barcodes })),
      prices: Object.entries(this.prices)
        .map(([k, price]) => {
          const [priceListId, unitId] = k.split('|');
          return { priceListId, unitId, price };
        })
        .filter((p) => this.priceUnits().includes(p.unitId)),
    };
    this.saving.set(true);
    this.errors.set({});
    try {
      await this.api.saveProduct(this.productId, body);
      this.notify.ok('Producto guardado');
      this.ref.close(true);
    } catch (e) {
      this.errors.set(apiFields(e));
      this.notify.error(e);
    } finally {
      this.saving.set(false);
    }
  }
}
