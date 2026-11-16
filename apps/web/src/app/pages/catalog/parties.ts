import { CurrencyPipe } from '@angular/common';
import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTableModule } from '@angular/material/table';
import { RouterLink } from '@angular/router';
import type { PartyItem, PartyRequest, PriceListItem } from '@vektra/shared-contracts';
import { validateCedula, validateRuc } from '@vektra/shared-domain';
import { AuthService } from '../../core/auth.service';
import { apiFields } from '../../core/http';
import { Notify } from '../../core/notify.service';
import { CatalogApi } from './catalog.api';

const ID_TYPES = [
  { code: '05', label: 'Cédula' },
  { code: '04', label: 'RUC' },
  { code: '06', label: 'Pasaporte' },
  { code: '08', label: 'Identificación del exterior' },
];

@Component({
  selector: 'vk-party-dialog',
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatSlideToggleModule],
  template: `
    <h2 mat-dialog-title>{{ party ? 'Editar' : 'Nuevo' }} {{ m.isSupplier && !m.isCustomer ? 'proveedor' : 'cliente' }}</h2>
    <mat-dialog-content>
      <div class="vk-form-grid">
        <mat-form-field>
          <mat-label>Tipo</mat-label>
          <mat-select [(ngModel)]="m.idType">
            @for (t of idTypes; track t.code) { <mat-option [value]="t.code">{{ t.label }}</mat-option> }
          </mat-select>
        </mat-form-field>
        <mat-form-field>
          <mat-label>Identificación</mat-label>
          <input matInput [(ngModel)]="m.identification" (blur)="check()" class="vk-mono" />
          @if (errors()['identification']) { <mat-hint class="err">{{ errors()['identification'] }}</mat-hint> }
        </mat-form-field>
        <mat-form-field class="vk-full"><mat-label>Nombre o razón social</mat-label><input matInput [(ngModel)]="m.name" /></mat-form-field>
        <mat-form-field class="vk-full"><mat-label>Nombre comercial</mat-label><input matInput [(ngModel)]="m.tradeName" /></mat-form-field>
        <mat-form-field class="vk-full">
          <mat-label>Correo(s) para facturas</mat-label><input matInput [(ngModel)]="m.email" />
          @if (errors()['email']) { <mat-hint class="err">{{ errors()['email'] }}</mat-hint> } @else { <mat-hint>Varios separados por coma</mat-hint> }
        </mat-form-field>
        <mat-form-field><mat-label>Teléfono / WhatsApp</mat-label><input matInput [(ngModel)]="m.phone" /></mat-form-field>
        <mat-form-field>
          <mat-label>Lista de precios</mat-label>
          <mat-select [(ngModel)]="m.priceListId">
            <mat-option [value]="null">Por defecto</mat-option>
            @for (l of lists; track l.id) { <mat-option [value]="l.id">{{ l.name }}</mat-option> }
          </mat-select>
        </mat-form-field>
        <mat-form-field class="vk-full"><mat-label>Dirección</mat-label><input matInput [(ngModel)]="m.address" /></mat-form-field>
        <mat-form-field><mat-label>Límite de crédito ($)</mat-label><input matInput [(ngModel)]="m.creditLimit" inputmode="decimal" /></mat-form-field>
        <mat-form-field><mat-label>Días de crédito</mat-label><input matInput type="number" [(ngModel)]="m.creditDays" /></mat-form-field>
        <mat-form-field class="vk-full"><mat-label>Notas</mat-label><textarea matInput rows="2" [(ngModel)]="m.notes"></textarea></mat-form-field>
      </div>
      <div class="toggles">
        <mat-slide-toggle [(ngModel)]="m.isCustomer">Cliente</mat-slide-toggle>
        <mat-slide-toggle [(ngModel)]="m.isSupplier">Proveedor</mat-slide-toggle>
        <mat-slide-toggle [(ngModel)]="m.active">Activo</mat-slide-toggle>
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancelar</button>
      <button matButton="filled" (click)="save()" [disabled]="saving()">Guardar</button>
    </mat-dialog-actions>
  `,
  styles: `.toggles { display: flex; gap: 24px; flex-wrap: wrap; margin-top: 8px; } .err { color: var(--vk-danger); }`,
})
export class PartyDialog {
  private readonly api = inject(CatalogApi);
  private readonly notify = inject(Notify);
  private readonly ref = inject(MatDialogRef<PartyDialog>);
  private readonly data = inject<{ party: PartyItem | null; lists: PriceListItem[]; supplier?: boolean }>(MAT_DIALOG_DATA);
  protected readonly party = this.data.party;
  protected readonly lists = this.data.lists;
  protected readonly idTypes = ID_TYPES;
  protected readonly saving = signal(false);
  protected readonly errors = signal<Record<string, string>>({});
  protected m = {
    idType: this.party?.idType ?? '05',
    identification: this.party?.identification ?? '',
    name: this.party?.name ?? '',
    tradeName: this.party?.tradeName ?? '',
    email: this.party?.email ?? '',
    phone: this.party?.phone ?? '',
    address: this.party?.address ?? '',
    isCustomer: this.party?.isCustomer ?? !this.data.supplier,
    isSupplier: this.party?.isSupplier ?? !!this.data.supplier,
    priceListId: this.party?.priceListId ?? null,
    creditLimit: this.party?.creditLimit ?? '0',
    creditDays: this.party?.creditDays ?? 0,
    notes: this.party?.notes ?? '',
    active: this.party?.active ?? true,
  };

  protected check(): void {
    const id = this.m.identification.trim();
    if (id.length === 13 && this.m.idType === '05') this.m.idType = '04';
    if (id.length === 10 && this.m.idType === '04') this.m.idType = '05';
    const r = this.m.idType === '04' ? validateRuc(id) : this.m.idType === '05' ? validateCedula(id) : { valid: true };
    this.errors.set(r.valid ? {} : { identification: ('error' in r && r.error) || 'Identificación inválida' });
  }

  protected async save(): Promise<void> {
    this.saving.set(true);
    try {
      const body: PartyRequest = { ...this.m, idType: this.m.idType as PartyRequest['idType'], identification: this.m.identification.trim(), creditDays: Number(this.m.creditDays) || 0 };
      await this.api.saveParty(this.party?.id ?? null, body);
      this.notify.ok('Guardado');
      this.ref.close(true);
    } catch (e) {
      this.errors.set(apiFields(e));
      this.notify.error(e);
    } finally {
      this.saving.set(false);
    }
  }
}

@Component({
  selector: 'vk-parties',
  imports: [MatTableModule, MatPaginatorModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatButtonToggleModule, FormsModule, CurrencyPipe, RouterLink],
  template: `
    <div class="vk-page">
      <div class="vk-page-header">
        <div>
          <h1>Clientes y proveedores</h1>
          <p>Con cédula o RUC validados. El correo se usa para enviar las facturas.</p>
        </div>
        @if (auth.can('customers.manage')) {
          <div class="vk-actions">
            <a matButton="outlined" routerLink="/importar"><span class="material-symbols-outlined">upload_file</span> Importar Excel</a>
            <button matButton="filled" (click)="open(null)"><span class="material-symbols-outlined">person_add</span> Nuevo</button>
          </div>
        }
      </div>
      <div class="filters">
        <mat-button-toggle-group [(ngModel)]="role" (change)="reload()" aria-label="Filtro">
          <mat-button-toggle value="customer">Clientes</mat-button-toggle>
          <mat-button-toggle value="supplier">Proveedores</mat-button-toggle>
          <mat-button-toggle value="">Todos</mat-button-toggle>
        </mat-button-toggle-group>
        <mat-form-field class="search">
          <mat-label>Buscar por nombre o identificación</mat-label>
          <input matInput [(ngModel)]="search" (keyup.enter)="reload()" />
        </mat-form-field>
      </div>
      <div class="vk-table-wrap">
        <table mat-table [dataSource]="rows()">
          <ng-container matColumnDef="name">
            <th mat-header-cell *matHeaderCellDef>Nombre</th>
            <td mat-cell *matCellDef="let p">
              <strong>{{ p.name }}</strong> @if (!p.active) { <span class="vk-badge">Inactivo</span> }
              <div class="vk-muted small"><span class="vk-mono">{{ p.identification }}</span>{{ p.tradeName ? ' · ' + p.tradeName : '' }}</div>
            </td>
          </ng-container>
          <ng-container matColumnDef="contact">
            <th mat-header-cell *matHeaderCellDef>Contacto</th>
            <td mat-cell *matCellDef="let p" class="small">{{ p.email ?? '' }}<div class="vk-muted">{{ p.phone ?? '' }}</div></td>
          </ng-container>
          <ng-container matColumnDef="type">
            <th mat-header-cell *matHeaderCellDef>Tipo</th>
            <td mat-cell *matCellDef="let p">
              @if (p.isCustomer) { <span class="vk-badge brand">Cliente</span> }
              @if (p.isSupplier) { <span class="vk-badge">Proveedor</span> }
            </td>
          </ng-container>
          <ng-container matColumnDef="credit">
            <th mat-header-cell *matHeaderCellDef>Crédito</th>
            <td mat-cell *matCellDef="let p" class="small">
              @if (+p.creditLimit > 0) { {{ p.creditLimit | currency }} · {{ p.creditDays }} días } @else { <span class="vk-muted">Contado</span> }
              @if (p.priceListName) { <div class="vk-muted">Lista {{ p.priceListName }}</div> }
            </td>
          </ng-container>
          <tr mat-header-row *matHeaderRowDef="columns"></tr>
          <tr mat-row *matRowDef="let r; columns: columns" class="row" (click)="open(r)"></tr>
        </table>
        @if (!rows().length) { <div class="vk-empty">Sin registros</div> }
        <mat-paginator [length]="total()" [pageSize]="pageSize" [pageSizeOptions]="[25, 50, 100]" (page)="page($event)" />
      </div>
    </div>
  `,
  styles: `
    .filters { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
    .search { flex: 1; min-width: 240px; } .small { font: var(--mat-sys-body-small); }
    .row { cursor: pointer; } .row:hover { background: var(--mat-sys-surface-container-low); }
  `,
})
export class PartiesPage implements OnInit {
  private readonly api = inject(CatalogApi);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(Notify);
  protected readonly auth = inject(AuthService);
  protected readonly rows = signal<PartyItem[]>([]);
  protected readonly total = signal(0);
  protected readonly columns = ['name', 'contact', 'type', 'credit'];
  protected role: 'customer' | 'supplier' | '' = 'customer';
  protected search = '';
  protected pageSize = 25;
  private pageIndex = 0;

  ngOnInit(): void {
    void this.reload();
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
      const r = await this.api.parties({ role: this.role, search: this.search, page: this.pageIndex + 1, pageSize: this.pageSize });
      this.rows.set(r.items);
      this.total.set(r.total);
    } catch (e) {
      this.notify.error(e);
    }
  }

  protected async open(party: PartyItem | null): Promise<void> {
    if (!this.auth.can('customers.manage')) return;
    const lists = (await this.api.lookups()).priceLists;
    this.dialog
      .open(PartyDialog, { data: { party, lists, supplier: this.role === 'supplier' }, width: 'min(680px, calc(100vw - 32px))', maxWidth: '100vw' })
      .afterClosed()
      .subscribe((ok) => ok && this.fetch());
  }
}
