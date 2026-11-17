import { Component, inject, input, output, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatAutocompleteModule, MatAutocompleteSelectedEvent } from '@angular/material/autocomplete';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import type { ProductSearchItem } from '@vektra/shared-contracts';
import { debounceTime, distinctUntilChanged, filter } from 'rxjs';
import { CatalogApi } from '../pages/catalog/catalog.api';

/**
 * Buscador de productos: escriba nombre o código, o escanee el código de barras (Enter selecciona
 * automáticamente si hay un único resultado — así funciona el lector de barras).
 */
@Component({
  selector: 'vk-product-picker',
  imports: [ReactiveFormsModule, MatAutocompleteModule, MatFormFieldModule, MatInputModule],
  template: `
    <mat-form-field class="w" [subscriptSizing]="'dynamic'">
      <mat-label>{{ label() }}</mat-label>
      <span class="material-symbols-outlined" matPrefix>barcode_scanner</span>
      <input matInput [formControl]="query" [matAutocomplete]="auto" (keydown.enter)="enter($event)" autocomplete="off" />
      <mat-autocomplete #auto="matAutocomplete" (optionSelected)="pick($event)" [displayWith]="display">
        @for (p of results(); track p.id) {
          <mat-option [value]="p">
            <span class="code">{{ p.code }}</span> {{ p.name }}
            @if (p.stock !== null) {
              <span class="stock" [class.neg]="+p.stock <= 0">· stock {{ +p.stock }}</span>
            }
          </mat-option>
        }
        @if (searched() && !results().length) {
          <mat-option disabled>Sin resultados</mat-option>
        }
      </mat-autocomplete>
    </mat-form-field>
  `,
  styles: `
    .w { width: 100%; }
    .code { font-family: ui-monospace, monospace; font-size: 12px; color: var(--vk-muted); margin-right: 6px; }
    .stock { color: var(--vk-muted); font-size: 12px; margin-left: 6px; }
    .neg { color: var(--vk-danger); }
    .material-symbols-outlined { margin: 0 6px 0 10px; color: var(--vk-muted); }
  `,
})
export class ProductPicker {
  private readonly api = inject(CatalogApi);
  readonly label = input('Buscar producto (nombre, código o código de barras)');
  readonly warehouseId = input<string | undefined>();
  readonly priceListId = input<string | undefined>();
  readonly picked = output<ProductSearchItem>();
  /** Enter sin resultados (código escaneado que no existe): permite el alta rápida. */
  readonly notFound = output<string>();

  protected readonly query = new FormControl<string | ProductSearchItem>('', { nonNullable: true });
  protected readonly results = signal<ProductSearchItem[]>([]);
  protected readonly searched = signal(false);
  private seq = 0;

  constructor() {
    this.query.valueChanges
      .pipe(
        filter((v): v is string => typeof v === 'string'),
        debounceTime(200),
        distinctUntilChanged(),
      )
      .subscribe((q) => void this.search(q));
  }

  protected display = (p: ProductSearchItem | string | null) => (typeof p === 'string' ? p : '');

  private async search(q: string): Promise<ProductSearchItem[]> {
    const term = q.trim();
    if (term.length < 2) {
      this.results.set([]);
      this.searched.set(false);
      return [];
    }
    const mine = ++this.seq;
    try {
      const r = await this.api.searchProducts(term, { warehouseId: this.warehouseId(), priceListId: this.priceListId() });
      if (mine === this.seq) {
        this.results.set(r);
        this.searched.set(true);
      }
      return r;
    } catch {
      return [];
    }
  }

  /** Lector de código de barras: escribe y envía Enter. */
  protected async enter(ev: Event): Promise<void> {
    const v = this.query.value;
    if (typeof v !== 'string' || !v.trim()) return;
    ev.preventDefault();
    const r = await this.search(v);
    // Lector de barras: si hay coincidencia exacta de código, se agrega aunque haya otros parecidos (TOR-1 / TOR-10)
    const exact = r.find((p) => p.code.toLowerCase() === v.trim().toLowerCase() || p.matchedUnitId !== null);
    if (r.length === 1) this.emit(r[0]);
    else if (exact) this.emit(exact);
    else if (!r.length) this.notFound.emit(v.trim());
  }

  protected pick(ev: MatAutocompleteSelectedEvent): void {
    this.emit(ev.option.value as ProductSearchItem);
  }

  /** Limpiar el buscador (p. ej. después de crear el producto que no existía). */
  clear(): void {
    this.query.setValue('');
    this.results.set([]);
    this.searched.set(false);
  }

  private emit(p: ProductSearchItem): void {
    this.picked.emit(p);
    this.query.setValue('');
    this.results.set([]);
    this.searched.set(false);
  }
}
