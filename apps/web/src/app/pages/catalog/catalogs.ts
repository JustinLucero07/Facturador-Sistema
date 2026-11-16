import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import type { CatalogLookups } from '@vektra/shared-contracts';
import { AuthService } from '../../core/auth.service';
import { Notify } from '../../core/notify.service';
import { CatalogApi } from './catalog.api';

type Kind = 'categories' | 'brands' | 'units' | 'price-lists';
interface Row {
  id: string | null;
  name: string;
  code?: string;
  allowsDecimal?: boolean;
  isDefault?: boolean;
  active: boolean;
  dirty?: boolean;
}

/** Categorías, marcas, unidades de medida y listas de precios (edición en línea). */
@Component({
  selector: 'vk-catalogs',
  imports: [FormsModule, MatButtonModule, MatCheckboxModule],
  template: `
    <div class="vk-page">
      <div class="vk-page-header">
        <div>
          <h1>Catálogos</h1>
          <p>Categorías, marcas, unidades de medida y listas de precios de su empresa.</p>
        </div>
      </div>
      <div class="grid">
        @for (s of sections; track s.kind) {
          <section class="vk-card">
            <div class="head">
              <h2>{{ s.title }}</h2>
              @if (canEdit) { <button matButton (click)="add(s.kind)"><span class="material-symbols-outlined">add</span> Agregar</button> }
            </div>
            <p class="vk-muted small">{{ s.hint }}</p>
            <ul>
              @for (r of rows()[s.kind]; track $index) {
                <li [class.off]="!r.active">
                  @if (s.kind === 'units' || s.kind === 'price-lists') {
                    <input class="cell code" [(ngModel)]="r.code" (ngModelChange)="r.dirty = true" [disabled]="!canEdit" placeholder="Código" />
                  }
                  <input class="cell" [(ngModel)]="r.name" (ngModelChange)="r.dirty = true" [disabled]="!canEdit" placeholder="Nombre" />
                  @if (s.kind === 'units') {
                    <mat-checkbox [(ngModel)]="r.allowsDecimal" (change)="r.dirty = true" [disabled]="!canEdit">Decimales</mat-checkbox>
                  }
                  @if (s.kind === 'price-lists') {
                    <mat-checkbox [(ngModel)]="r.isDefault" (change)="r.dirty = true" [disabled]="!canEdit">Por defecto</mat-checkbox>
                  }
                  <mat-checkbox [(ngModel)]="r.active" (change)="r.dirty = true" [disabled]="!canEdit">Activo</mat-checkbox>
                  @if (r.dirty) { <button matButton="tonal" (click)="save(s.kind, r)">Guardar</button> }
                </li>
              } @empty {
                <li class="vk-muted">Sin registros</li>
              }
            </ul>
          </section>
        }
      </div>
    </div>
  `,
  styles: `
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 16px; align-items: start; }
    .head { display: flex; justify-content: space-between; align-items: center; }
    h2 { font: var(--mat-sys-title-medium); margin: 0; }
    .small { font: var(--mat-sys-body-small); margin: 4px 0 8px; }
    ul { list-style: none; padding: 0; margin: 0; max-height: 420px; overflow: auto; }
    li { display: flex; gap: 8px; align-items: center; padding: 4px 0; border-bottom: 1px solid var(--mat-sys-outline-variant); flex-wrap: wrap; }
    li.off .cell { opacity: .55; }
    .cell { flex: 1; min-width: 120px; border: 1px solid transparent; border-radius: 6px; padding: 6px 8px; font: inherit; background: transparent; color: inherit; }
    .cell:enabled:hover, .cell:focus { border-color: var(--mat-sys-outline); outline: none; background: var(--mat-sys-surface); }
    .code { flex: 0 0 90px; min-width: 0; font-family: ui-monospace, monospace; text-transform: uppercase; }
  `,
})
export class CatalogsPage implements OnInit {
  private readonly api = inject(CatalogApi);
  private readonly notify = inject(Notify);
  protected readonly canEdit = inject(AuthService).can('catalog.manage');
  protected readonly sections: { kind: Kind; title: string; hint: string }[] = [
    { kind: 'categories', title: 'Categorías', hint: 'Agrupan productos para buscar y reportar.' },
    { kind: 'brands', title: 'Marcas', hint: 'Opcional en cada producto.' },
    { kind: 'units', title: 'Unidades de medida', hint: 'Marque "Decimales" para vender por kilo, metro o litro.' },
    { kind: 'price-lists', title: 'Listas de precios', hint: 'Cada cliente puede tener su lista; la "por defecto" se usa para consumidor final.' },
  ];
  protected readonly rows = signal<Record<Kind, Row[]>>({ categories: [], brands: [], units: [], 'price-lists': [] });

  async ngOnInit(): Promise<void> {
    this.fill(await this.api.lookups(true));
  }

  private fill(lk: CatalogLookups): void {
    this.rows.set({
      categories: lk.categories.map((c) => ({ ...c })),
      brands: lk.brands.map((b) => ({ ...b })),
      units: lk.units.map((u) => ({ ...u })),
      'price-lists': lk.priceLists.map((l) => ({ ...l })),
    });
  }

  protected add(kind: Kind): void {
    const r = this.rows();
    this.rows.set({ ...r, [kind]: [{ id: null, name: '', code: '', active: true, allowsDecimal: false, isDefault: false, dirty: true }, ...r[kind]] });
  }

  protected async save(kind: Kind, r: Row): Promise<void> {
    const body =
      kind === 'units'
        ? { code: r.code ?? '', name: r.name, allowsDecimal: !!r.allowsDecimal, active: r.active }
        : kind === 'price-lists'
          ? { code: r.code ?? '', name: r.name, isDefault: !!r.isDefault, active: r.active }
          : { name: r.name, active: r.active };
    try {
      const res = await this.api.saveCatalog(kind, r.id, body);
      if (!r.id && res && typeof res === 'object' && 'id' in res) r.id = (res as { id: string }).id;
      r.dirty = false;
      this.notify.ok('Guardado');
      if (kind === 'price-lists' && r.isDefault) this.fill(await this.api.lookups(true));
    } catch (e) {
      this.notify.error(e);
    }
  }
}
