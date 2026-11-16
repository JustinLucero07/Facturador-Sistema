import { CurrencyPipe, DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, inject, OnInit, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { MatSelectModule } from '@angular/material/select';
import { MatTableModule } from '@angular/material/table';
import type { ClientItem, InstallationCredentials, InstallationItem, PlanItem } from '@vektra/shared-contracts';
import { firstValueFrom } from 'rxjs';
import { Toast } from '../hub';

@Component({
  selector: 'hub-installations',
  imports: [ReactiveFormsModule, MatTableModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatMenuModule, DatePipe, CurrencyPipe],
  template: `
    <div class="vk-page">
      <div class="vk-page-header">
        <div>
          <h1>Instalaciones</h1>
          <p>Cada VPS de cliente con Vektra POS. Validan su licencia cada hora.</p>
        </div>
      </div>

      @if (secret(); as s) {
        <section class="vk-card secret">
          <h2>Credenciales de la instalación</h2>
          <p>Cópielas ahora en el <code>.env</code> de la VPS del cliente. <strong>El secreto no se volverá a mostrar.</strong></p>
          <pre class="vk-mono">{{ s.envSnippet }}</pre>
          <div class="vk-actions">
            <button matButton (click)="copy(s.envSnippet)">Copiar</button>
            <button matButton="filled" (click)="secret.set(null)">Listo</button>
          </div>
        </section>
      }

      @if (offline(); as o) {
        <section class="vk-card secret">
          <h2>Código de activación offline</h2>
          <p>Válido hasta {{ o.expiresAt | date: 'medium' }}. El cliente lo pega en Empresa → Licencia.</p>
          <pre class="vk-mono code">{{ o.code }}</pre>
          <div class="vk-actions">
            <button matButton (click)="copy(o.code)">Copiar</button>
            <button matButton="filled" (click)="offline.set(null)">Listo</button>
          </div>
        </section>
      }

      <div class="grid">
        <div class="vk-table-wrap">
          <table mat-table [dataSource]="items()">
            <ng-container matColumnDef="name">
              <th mat-header-cell *matHeaderCellDef>Instalación</th>
              <td mat-cell *matCellDef="let i">
                <strong>{{ i.name }}</strong>
                <div class="vk-muted">{{ i.clientName }} · <span class="vk-mono">{{ i.publicId }}</span></div>
              </td>
            </ng-container>
            <ng-container matColumnDef="plan">
              <th mat-header-cell *matHeaderCellDef>Plan</th>
              <td mat-cell *matCellDef="let i">{{ i.planName }}</td>
            </ng-container>
            <ng-container matColumnDef="seen">
              <th mat-header-cell *matHeaderCellDef>Último contacto</th>
              <td mat-cell *matCellDef="let i">
                @if (i.lastSeenAt) {
                  <span class="vk-badge" [class.ok]="fresh(i.lastSeenAt)" [class.warn]="!fresh(i.lastSeenAt)">{{ i.lastSeenAt | date: 'short' }}</span>
                  @if (i.lastReport) {
                    <div class="vk-muted small">{{ i.lastReport['users'] }} usuarios · {{ i.lastReport['emissionPoints'] }} cajas</div>
                  }
                } @else {
                  <span class="vk-badge">Nunca</span>
                }
              </td>
            </ng-container>
            <ng-container matColumnDef="health">
              <th mat-header-cell *matHeaderCellDef>Salud SRI</th>
              <td mat-cell *matCellDef="let i">
                @for (h of health(i); track h.ruc) {
                  <div class="small">
                    <strong>{{ h.name }}</strong>
                    @if (h.certDays === null) {
                      <span class="vk-badge danger">sin firma</span>
                    } @else if (h.certDays <= 30) {
                      <span class="vk-badge" [class.warn]="h.certDays > 5" [class.danger]="h.certDays <= 5">firma: {{ h.certDays }} d</span>
                    }
                    @if (h.rejected24h > 0) {
                      <span class="vk-badge danger">{{ h.rejected24h }} rechazos 24 h</span>
                    }
                    @if (h.pending > 0) {
                      <span class="vk-badge warn">{{ h.pending }} pendientes</span>
                    }
                    <span class="vk-muted"> · {{ h.authorized24h }} autorizados 24 h</span>
                  </div>
                } @empty {
                  <span class="vk-muted small">Sin reporte</span>
                }
              </td>
            </ng-container>
            <ng-container matColumnDef="status">
              <th mat-header-cell *matHeaderCellDef>Estado</th>
              <td mat-cell *matCellDef="let i">
                <span class="vk-badge" [class.ok]="i.status === 'ACTIVE'" [class.danger]="i.status !== 'ACTIVE'">{{ statusLabel[i.status] }}</span>
              </td>
            </ng-container>
            <ng-container matColumnDef="actions">
              <th mat-header-cell *matHeaderCellDef></th>
              <td mat-cell *matCellDef="let i">
                <button matIconButton [matMenuTriggerFor]="m" aria-label="Acciones"><span class="material-symbols-outlined">more_vert</span></button>
                <mat-menu #m="matMenu" xPosition="before">
                  <button mat-menu-item (click)="offlineCode(i)">Código offline (7 días)</button>
                  <button mat-menu-item (click)="rotate(i)">Regenerar secreto</button>
                  @if (i.status === 'ACTIVE') {
                    <button mat-menu-item (click)="setStatus(i, 'SUSPENDED')">Suspender (falta de pago)</button>
                  } @else {
                    <button mat-menu-item (click)="setStatus(i, 'ACTIVE')">Reactivar</button>
                  }
                </mat-menu>
              </td>
            </ng-container>
            <tr mat-header-row *matHeaderRowDef="columns"></tr>
            <tr mat-row *matRowDef="let r; columns: columns"></tr>
          </table>
          @if (items().length === 0) {
            <div class="vk-empty">Aún no hay instalaciones</div>
          }
        </div>

        <form class="vk-card" [formGroup]="form" (ngSubmit)="create()">
          <h2>Nueva instalación</h2>
          <mat-form-field class="w">
            <mat-label>Cliente</mat-label>
            <mat-select formControlName="clientId">
              @for (c of clients(); track c.id) {
                <mat-option [value]="c.id">{{ c.tradeName ?? c.legalName }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field class="w">
            <mat-label>Plan</mat-label>
            <mat-select formControlName="planId">
              @for (p of plans(); track p.id) {
                <mat-option [value]="p.id">{{ p.name }} · {{ p.priceMonthly | currency }}/mes</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field class="w">
            <mat-label>Nombre</mat-label>
            <input matInput formControlName="name" placeholder="VPS Ferretería X" />
          </mat-form-field>
          <mat-form-field class="w">
            <mat-label>URL del sistema (opcional)</mat-label>
            <input matInput formControlName="baseUrl" placeholder="https://facturas.ferreteriax.com" />
          </mat-form-field>
          <div class="vk-actions"><button matButton="filled" type="submit">Crear</button></div>
        </form>
      </div>
    </div>
  `,
  styles: `
    .grid { display: grid; grid-template-columns: minmax(0, 1.8fr) minmax(280px, 1fr); gap: 16px; align-items: start; }
    h2 { font: var(--mat-sys-title-medium); margin: 0 0 12px; }
    .w { width: 100%; }
    .small { font: var(--mat-sys-body-small); margin-top: 2px; }
    .secret { margin-bottom: 16px; border-color: var(--mat-sys-primary); }
    pre { background: var(--mat-sys-surface-container); padding: 12px; border-radius: 8px; white-space: pre-wrap; word-break: break-all; }
    .code { max-height: 120px; overflow: auto; }
    @media (max-width: 959px) { .grid { grid-template-columns: 1fr; } }
  `,
})
export class InstallationsPage implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly toast = inject(Toast);
  protected readonly items = signal<InstallationItem[]>([]);
  protected readonly clients = signal<ClientItem[]>([]);
  protected readonly plans = signal<PlanItem[]>([]);
  protected readonly secret = signal<InstallationCredentials | null>(null);
  protected readonly offline = signal<{ code: string; expiresAt: string } | null>(null);
  protected readonly columns = ['name', 'plan', 'seen', 'health', 'status', 'actions'];
  protected readonly statusLabel: Record<string, string> = { ACTIVE: 'Activa', SUSPENDED: 'Suspendida', CANCELLED: 'Cancelada' };
  protected readonly form = new FormGroup({
    clientId: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    planId: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    name: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    baseUrl: new FormControl<string | null>(null),
  });

  async ngOnInit(): Promise<void> {
    const [c, p] = await Promise.all([
      firstValueFrom(this.http.get<ClientItem[]>('/api/hub/clients')),
      firstValueFrom(this.http.get<PlanItem[]>('/api/hub/plans')),
    ]);
    this.clients.set(c);
    this.plans.set(p.filter((x) => x.active));
    await this.load();
  }

  private async load(): Promise<void> {
    this.items.set(await firstValueFrom(this.http.get<InstallationItem[]>('/api/hub/installations')));
  }

  /** Telemetría por empresa enviada por la instancia en cada validación de licencia. */
  protected health(i: InstallationItem) {
    const companies = (i.lastReport?.['companies'] as { ruc: string; name: string; certificateValidTo: string | null; rejected24h: number; pending: number; authorized24h: number }[] | undefined) ?? [];
    return companies.map((c) => ({
      ...c,
      certDays: c.certificateValidTo ? Math.floor((new Date(c.certificateValidTo).getTime() - Date.now()) / 86_400_000) : null,
    }));
  }

  /** Contacto en las últimas 2 h = sana (valida cada hora). */
  protected fresh(at: string): boolean {
    return Date.now() - new Date(at).getTime() < 2 * 3600_000;
  }

  protected async create(): Promise<void> {
    if (this.form.invalid) return this.form.markAllAsTouched();
    try {
      this.secret.set(await firstValueFrom(this.http.post<InstallationCredentials>('/api/hub/installations', this.form.getRawValue())));
      this.form.reset();
      await this.load();
    } catch (e) {
      this.toast.error(e);
    }
  }

  protected async rotate(i: InstallationItem): Promise<void> {
    if (!confirm(`¿Regenerar el secreto de "${i.name}"? La instalación dejará de validar hasta actualizar su .env.`)) return;
    try {
      this.secret.set(await firstValueFrom(this.http.post<InstallationCredentials>(`/api/hub/installations/${i.id}/rotate-secret`, {})));
    } catch (e) {
      this.toast.error(e);
    }
  }

  protected async offlineCode(i: InstallationItem): Promise<void> {
    try {
      this.offline.set(await firstValueFrom(this.http.post<{ code: string; expiresAt: string }>(`/api/hub/installations/${i.id}/offline-code`, { days: 7 })));
    } catch (e) {
      this.toast.error(e);
    }
  }

  protected async setStatus(i: InstallationItem, status: 'ACTIVE' | 'SUSPENDED'): Promise<void> {
    try {
      await firstValueFrom(this.http.patch(`/api/hub/installations/${i.id}`, { status }));
      this.toast.ok(status === 'SUSPENDED' ? 'Suspendida: se aplicará en la próxima validación (máx. 1 h)' : 'Reactivada');
      await this.load();
    } catch (e) {
      this.toast.error(e);
    }
  }

  protected copy(text: string): void {
    void navigator.clipboard?.writeText(text).then(() => this.toast.ok('Copiado'));
  }
}
