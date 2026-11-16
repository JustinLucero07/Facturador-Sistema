import { HttpClient } from '@angular/common/http';
import { Component, inject, OnInit, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatTableModule } from '@angular/material/table';
import type { ClientItem } from '@vektra/shared-contracts';
import { firstValueFrom } from 'rxjs';
import { Toast } from '../hub';

@Component({
  selector: 'hub-clients',
  imports: [ReactiveFormsModule, MatTableModule, MatButtonModule, MatFormFieldModule, MatInputModule],
  template: `
    <div class="vk-page">
      <div class="vk-page-header">
        <div>
          <h1>Clientes</h1>
          <p>Negocios que compraron Vektra POS.</p>
        </div>
      </div>
      <div class="grid">
        <div class="vk-table-wrap">
          <table mat-table [dataSource]="items()">
            <ng-container matColumnDef="name">
              <th mat-header-cell *matHeaderCellDef>Cliente</th>
              <td mat-cell *matCellDef="let c">
                <strong>{{ c.tradeName ?? c.legalName }}</strong>
                <div class="vk-muted vk-mono">{{ c.ruc }}</div>
              </td>
            </ng-container>
            <ng-container matColumnDef="contact">
              <th mat-header-cell *matHeaderCellDef>Contacto</th>
              <td mat-cell *matCellDef="let c">
                {{ c.contactName ?? '—' }}
                <div class="vk-muted">{{ c.phone ?? '' }} {{ c.email ?? '' }}</div>
              </td>
            </ng-container>
            <ng-container matColumnDef="city">
              <th mat-header-cell *matHeaderCellDef>Ciudad</th>
              <td mat-cell *matCellDef="let c">{{ c.city ?? '' }}</td>
            </ng-container>
            <ng-container matColumnDef="inst">
              <th mat-header-cell *matHeaderCellDef>Instalaciones</th>
              <td mat-cell *matCellDef="let c">{{ c.installationCount }}</td>
            </ng-container>
            <tr mat-header-row *matHeaderRowDef="columns"></tr>
            <tr mat-row *matRowDef="let r; columns: columns"></tr>
          </table>
          @if (items().length === 0) {
            <div class="vk-empty">Aún no hay clientes</div>
          }
        </div>
        <form class="vk-card" [formGroup]="form" (ngSubmit)="create()">
          <h2>Nuevo cliente</h2>
          <mat-form-field class="w"><mat-label>RUC</mat-label><input matInput formControlName="ruc" maxlength="13" /></mat-form-field>
          <mat-form-field class="w"><mat-label>Razón social</mat-label><input matInput formControlName="legalName" /></mat-form-field>
          <mat-form-field class="w"><mat-label>Nombre comercial</mat-label><input matInput formControlName="tradeName" /></mat-form-field>
          <mat-form-field class="w"><mat-label>Contacto</mat-label><input matInput formControlName="contactName" /></mat-form-field>
          <mat-form-field class="w"><mat-label>Teléfono / WhatsApp</mat-label><input matInput formControlName="phone" /></mat-form-field>
          <mat-form-field class="w"><mat-label>Correo</mat-label><input matInput type="email" formControlName="email" /></mat-form-field>
          <mat-form-field class="w"><mat-label>Ciudad</mat-label><input matInput formControlName="city" /></mat-form-field>
          <div class="vk-actions"><button matButton="filled" type="submit">Guardar</button></div>
        </form>
      </div>
    </div>
  `,
  styles: `
    .grid { display: grid; grid-template-columns: minmax(0, 1.8fr) minmax(280px, 1fr); gap: 16px; align-items: start; }
    h2 { font: var(--mat-sys-title-medium); margin: 0 0 12px; }
    .w { width: 100%; }
    @media (max-width: 959px) { .grid { grid-template-columns: 1fr; } }
  `,
})
export class ClientsPage implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly toast = inject(Toast);
  protected readonly items = signal<ClientItem[]>([]);
  protected readonly columns = ['name', 'contact', 'city', 'inst'];
  protected readonly form = new FormGroup({
    ruc: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.pattern(/^\d{13}$/)] }),
    legalName: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    tradeName: new FormControl<string | null>(null),
    contactName: new FormControl<string | null>(null),
    phone: new FormControl<string | null>(null),
    email: new FormControl<string | null>(null, [Validators.email]),
    city: new FormControl<string | null>(null),
  });

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  private async load(): Promise<void> {
    this.items.set(await firstValueFrom(this.http.get<ClientItem[]>('/api/hub/clients')));
  }

  protected async create(): Promise<void> {
    if (this.form.invalid) return this.form.markAllAsTouched();
    const v = this.form.getRawValue();
    const body = Object.fromEntries(Object.entries(v).map(([k, val]) => [k, val === '' ? null : val]));
    try {
      await firstValueFrom(this.http.post('/api/hub/clients', body));
      this.toast.ok('Cliente creado');
      this.form.reset();
      await this.load();
    } catch (e) {
      this.toast.error(e);
    }
  }
}
