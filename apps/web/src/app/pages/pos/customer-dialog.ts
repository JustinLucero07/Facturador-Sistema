import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { validateCedula, validateRuc } from '@vektra/shared-domain';
import { AuthService } from '../../core/auth.service';
import { apiMessage } from '../../core/http';
import { CatalogApi } from '../catalog/catalog.api';

export interface PosCustomer {
  idType: '04' | '05' | '06' | '07' | '08';
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  priceListId: string | null;
  priceListName: string | null;
  creditLimit: string;
}

export const FINAL_CONSUMER: PosCustomer = {
  idType: '07',
  id: '9999999999999',
  name: 'CONSUMIDOR FINAL',
  email: null,
  phone: null,
  address: null,
  priceListId: null,
  priceListName: null,
  creditLimit: '0',
};

/** Cliente rápido: escriba o escanee la cédula/RUC; si no existe, se crea aquí mismo. */
@Component({
  selector: 'vk-customer-dialog',
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule],
  template: `
    <h2 mat-dialog-title>Cliente</h2>
    <mat-dialog-content>
      <form (ngSubmit)="lookup()" class="search">
        <mat-form-field class="w">
          <mat-label>Cédula, RUC o pasaporte</mat-label>
          <input matInput name="id" [(ngModel)]="id" cdkFocusInitial inputmode="numeric" autocomplete="off" />
          @if (error()) { <mat-hint class="err">{{ error() }}</mat-hint> }
        </mat-form-field>
        <button matButton="tonal" type="submit" [disabled]="busy()">Buscar</button>
      </form>

      @if (found(); as c) {
        <div class="found">
          <span class="material-symbols-outlined">person</span>
          <div>
            <strong>{{ c.name }}</strong>
            <div class="vk-muted small">{{ c.id }}{{ c.email ? ' · ' + c.email : '' }}{{ c.priceListName ? ' · Lista ' + c.priceListName : '' }}</div>
          </div>
        </div>
      } @else if (creating()) {
        <p class="vk-muted">Cliente nuevo — complete sus datos:</p>
        <div class="vk-form-grid">
          <mat-form-field class="vk-full"><mat-label>Nombre o razón social</mat-label><input matInput [(ngModel)]="name" name="name" /></mat-form-field>
          <mat-form-field class="vk-full"><mat-label>Correo (para enviar la factura)</mat-label><input matInput [(ngModel)]="email" name="email" type="email" /></mat-form-field>
          <mat-form-field><mat-label>Teléfono / WhatsApp</mat-label><input matInput [(ngModel)]="phone" name="phone" inputmode="tel" /></mat-form-field>
          <mat-form-field><mat-label>Dirección</mat-label><input matInput [(ngModel)]="address" name="address" /></mat-form-field>
        </div>
      }
    </mat-dialog-content>
    <mat-dialog-actions>
      <button matButton (click)="finalConsumer()">Consumidor final</button>
      <span class="spacer"></span>
      <button matButton mat-dialog-close>Cancelar</button>
      @if (found()) {
        <button matButton="filled" (click)="use(found()!)">Usar este cliente</button>
      } @else if (creating()) {
        <button matButton="filled" (click)="create()" [disabled]="busy() || !name.trim()">{{ canSave ? 'Guardar y usar' : 'Usar sin guardar' }}</button>
      }
    </mat-dialog-actions>
  `,
  styles: `
    .search { display: flex; gap: 8px; align-items: flex-start; } .w { flex: 1; }
    .found { display: flex; gap: 12px; align-items: center; padding: 12px; border-radius: 12px; background: var(--mat-sys-primary-container); color: var(--mat-sys-on-primary-container); }
    .small { font: var(--mat-sys-body-small); } .err { color: var(--vk-danger); } .spacer { flex: 1; }
  `,
})
export class CustomerDialog {
  private readonly api = inject(CatalogApi);
  private readonly ref = inject(MatDialogRef<CustomerDialog, PosCustomer>);
  private readonly initial = inject<PosCustomer | null>(MAT_DIALOG_DATA);
  protected readonly canSave = inject(AuthService).can('customers.manage');
  protected readonly found = signal<PosCustomer | null>(this.initial && this.initial.idType !== '07' ? this.initial : null);
  protected readonly creating = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected id = this.initial && this.initial.idType !== '07' ? this.initial.id : '';
  protected name = '';
  protected email = '';
  protected phone = '';
  protected address = '';

  private idType(): PosCustomer['idType'] {
    const id = this.id.trim();
    return /^\d{13}$/.test(id) ? '04' : /^\d{10}$/.test(id) ? '05' : '06';
  }

  protected async lookup(): Promise<void> {
    const id = this.id.trim();
    this.found.set(null);
    this.creating.set(false);
    this.error.set(null);
    if (!id) return;
    const type = this.idType();
    const v = type === '04' ? validateRuc(id) : type === '05' ? validateCedula(id) : { valid: true };
    if (!v.valid) return this.error.set(('error' in v && v.error) || 'Identificación inválida');
    this.busy.set(true);
    try {
      const p = await this.api.partyByIdentification(id);
      if (p) {
        this.found.set({
          idType: p.idType,
          id: p.identification,
          name: p.name,
          email: p.email ? p.email.split(/[;,]/)[0].trim() : null,
          phone: p.phone,
          address: p.address,
          priceListId: p.priceListId ?? null,
          priceListName: p.priceListName,
          creditLimit: p.creditLimit,
        });
      } else this.creating.set(true);
    } catch (e) {
      this.error.set(apiMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected use(c: PosCustomer): void {
    this.ref.close(c);
  }

  protected finalConsumer(): void {
    this.ref.close(FINAL_CONSUMER);
  }

  protected async create(): Promise<void> {
    const c: PosCustomer = {
      idType: this.idType(),
      id: this.id.trim(),
      name: this.name.trim(),
      email: this.email.trim() || null,
      phone: this.phone.trim() || null,
      address: this.address.trim() || null,
      priceListId: null,
      priceListName: null,
      creditLimit: '0',
    };
    if (this.canSave) {
      this.busy.set(true);
      try {
        await this.api.saveParty(null, { idType: c.idType as '04', identification: c.id, name: c.name, email: c.email, phone: c.phone, address: c.address, isCustomer: true });
      } catch (e) {
        this.error.set(apiMessage(e));
        this.busy.set(false);
        return;
      }
    }
    this.ref.close(c);
  }
}
