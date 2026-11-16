import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { MatSelectModule } from '@angular/material/select';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterLink } from '@angular/router';
import type { DeviceItem, DevicePairingCode, EstablishmentItem, SyncOpItem } from '@vektra/shared-contracts';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth.service';
import { Notify } from '../../core/notify.service';

const OP_LABELS: Record<string, string> = {
  'invoice.issue': 'Factura',
  'cash.open': 'Apertura de caja',
  'cash.movement': 'Ingreso/egreso de caja',
  'cash.close': 'Cierre de caja',
  'party.upsert': 'Cliente',
  'product.create': 'Producto nuevo',
  'quote.create': 'Proforma',
  'document.email': 'Envío por correo',
};

/** Código de vinculación: se muestra una sola vez. */
@Component({
  selector: 'vk-pairing-code',
  imports: [MatDialogModule, MatButtonModule, DatePipe],
  template: `
    <h2 mat-dialog-title>Vincular "{{ data.device.name }}"</h2>
    <mat-dialog-content>
      <ol class="steps">
        <li>Instale <strong>Vektra Caja</strong> en la computadora de la caja.</li>
        <li>En "Dirección del servidor" escriba: <code>{{ origin }}</code></li>
        <li>Ingrese este código:</li>
      </ol>
      <div class="code" aria-label="Código de vinculación">{{ pretty }}</div>
      <p class="vk-muted">Vence {{ data.expiresAt | date: 'shortTime' }} (30 minutos). Es de un solo uso: no lo comparta.</p>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton (click)="copy()">Copiar código</button>
      <button matButton="filled" mat-dialog-close>Listo</button>
    </mat-dialog-actions>
  `,
  styles: `
    .steps { padding-left: 20px; margin: 0 0 12px; line-height: 1.8; }
    code { background: var(--mat-sys-surface-container-high); padding: 2px 6px; border-radius: 6px; }
    .code { font: 600 34px/1.2 ui-monospace, monospace; letter-spacing: 0.18em; text-align: center; padding: 18px; border-radius: 16px; background: var(--mat-sys-primary-container); color: var(--mat-sys-on-primary-container); margin: 8px 0 12px; }
  `,
})
export class PairingCodeDialog {
  protected readonly data = inject<DevicePairingCode>(MAT_DIALOG_DATA);
  private readonly notify = inject(Notify);
  protected readonly origin = window.location.origin;
  protected readonly pretty = `${this.data.code.slice(0, 5)} ${this.data.code.slice(5)}`;

  protected async copy(): Promise<void> {
    await navigator.clipboard?.writeText(this.data.code).catch(() => undefined);
    this.notify.ok('Código copiado');
  }
}

/** Nueva caja: elegir un punto de emisión de tipo "Caja de escritorio" que no tenga caja. */
@Component({
  selector: 'vk-new-device',
  imports: [MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, ReactiveFormsModule, RouterLink],
  template: `
    <h2 mat-dialog-title>Nueva caja de escritorio</h2>
    <mat-dialog-content>
      @if (!data.points.length) {
        <p>
          No hay puntos de emisión libres de tipo <strong>Caja de escritorio</strong>. Créelo en
          <a routerLink="/establecimientos" mat-dialog-close>Establecimientos</a> (cada caja de escritorio usa su propio punto, por ejemplo 001-002).
        </p>
      } @else {
        <form [formGroup]="form" class="f" (ngSubmit)="save()">
          <mat-form-field>
            <mat-label>Punto de emisión</mat-label>
            <mat-select formControlName="emissionPointId">
              @for (p of data.points; track p.id) { <mat-option [value]="p.id">{{ p.label }}</mat-option> }
            </mat-select>
          </mat-form-field>
          <mat-form-field>
            <mat-label>Nombre de la caja</mat-label>
            <input matInput formControlName="name" placeholder="Caja mostrador" />
          </mat-form-field>
        </form>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancelar</button>
      @if (data.points.length) { <button matButton="filled" (click)="save()" [disabled]="busy()">Crear y generar código</button> }
    </mat-dialog-actions>
  `,
  styles: `.f { display: flex; flex-direction: column; gap: 8px; min-width: min(420px, 80vw); padding-top: 8px; }`,
})
export class NewDeviceDialog {
  protected readonly data = inject<{ points: { id: string; label: string }[] }>(MAT_DIALOG_DATA);
  private readonly http = inject(HttpClient);
  private readonly notify = inject(Notify);
  private readonly ref = inject(MatDialogRef<NewDeviceDialog, DevicePairingCode>);
  protected readonly busy = signal(false);
  protected readonly form = new FormGroup({
    emissionPointId: new FormControl(this.data.points[0]?.id ?? '', { nonNullable: true, validators: [Validators.required] }),
    name: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.minLength(2)] }),
  });

  protected async save(): Promise<void> {
    if (this.form.invalid) return this.notify.error('Elija el punto de emisión y escriba un nombre');
    this.busy.set(true);
    try {
      this.ref.close(await firstValueFrom(this.http.post<DevicePairingCode>('/api/devices', this.form.getRawValue())));
    } catch (e) {
      this.notify.error(e);
    } finally {
      this.busy.set(false);
    }
  }
}

/** Bitácora de sincronización de una caja (rechazos primero). */
@Component({
  selector: 'vk-device-ops',
  imports: [MatDialogModule, MatButtonModule, DatePipe],
  template: `
    <h2 mat-dialog-title>Sincronización · {{ data.device.name }}</h2>
    <mat-dialog-content>
      @for (o of ops(); track o.id) {
        <div class="op" [class.bad]="o.status === 'REJECTED'">
          <div>
            <strong>{{ label(o.type) }}</strong>
            <span class="vk-muted"> · en la caja {{ o.clientAt | date: 'short' }} · recibido {{ o.processedAt | date: 'short' }}</span>
          </div>
          @if (o.message) { <div class="msg">{{ o.message }}</div> }
        </div>
      } @empty {
        <p class="vk-muted">Sin operaciones recibidas todavía.</p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end"><button matButton mat-dialog-close>Cerrar</button></mat-dialog-actions>
  `,
  styles: `
    .op { padding: 10px 0; border-bottom: 1px solid var(--mat-sys-outline-variant); min-width: min(560px, 80vw); }
    .bad strong { color: var(--vk-danger); }
    .msg { font: var(--mat-sys-body-small); color: var(--vk-danger); margin-top: 2px; }
  `,
})
export class DeviceOpsDialog implements OnInit {
  protected readonly data = inject<{ device: DeviceItem }>(MAT_DIALOG_DATA);
  private readonly http = inject(HttpClient);
  protected readonly ops = signal<SyncOpItem[]>([]);
  protected readonly label = (t: string) => OP_LABELS[t] ?? t;

  async ngOnInit(): Promise<void> {
    const all = await firstValueFrom(this.http.get<SyncOpItem[]>(`/api/devices/${this.data.device.id}/ops`));
    this.ops.set([...all.filter((o) => o.status === 'REJECTED'), ...all.filter((o) => o.status !== 'REJECTED')]);
  }
}

@Component({
  selector: 'vk-devices',
  imports: [MatTableModule, MatButtonModule, MatMenuModule, MatTooltipModule, DatePipe],
  template: `
    <div class="vk-page">
      <div class="vk-page-header">
        <div>
          <h1>Cajas de escritorio</h1>
          <p>Computadoras que facturan aunque se vaya el internet. Cada una usa su propio punto de emisión y se sincroniza sola al volver la conexión.</p>
        </div>
        @if (auth.can('structure.manage')) {
          <button matButton="filled" (click)="create()"><span class="material-symbols-outlined">add</span> Nueva caja</button>
        }
      </div>

      <div class="vk-table-wrap">
        <table mat-table [dataSource]="devices()">
          <ng-container matColumnDef="name">
            <th mat-header-cell *matHeaderCellDef>Caja</th>
            <td mat-cell *matCellDef="let d">
              <div class="name">{{ d.name }}</div>
              <div class="vk-muted">{{ d.emissionPoint }}{{ d.appVersion ? ' · v' + d.appVersion : '' }}</div>
            </td>
          </ng-container>
          <ng-container matColumnDef="status">
            <th mat-header-cell *matHeaderCellDef>Estado</th>
            <td mat-cell *matCellDef="let d">
              @switch (d.status) {
                @case ('active') { <span class="vk-badge" [class.ok]="!stale(d)" [class.warn]="stale(d)">{{ stale(d) ? 'Sin conexión' : 'Conectada' }}</span> }
                @case ('pending') { <span class="vk-badge brand">{{ d.pairingExpiresAt ? 'Esperando vinculación' : 'Código vencido' }}</span> }
                @default { <span class="vk-badge danger">Revocada</span> }
              }
            </td>
          </ng-container>
          <ng-container matColumnDef="sync">
            <th mat-header-cell *matHeaderCellDef>Última sincronización</th>
            <td mat-cell *matCellDef="let d" class="vk-muted">{{ d.lastSyncAt ? (d.lastSyncAt | date: 'short') : 'Nunca' }}</td>
          </ng-container>
          <ng-container matColumnDef="pending">
            <th mat-header-cell *matHeaderCellDef>Pendientes</th>
            <td mat-cell *matCellDef="let d">
              @if (d.failedOps > 0) { <span class="vk-badge danger" matTooltip="Operaciones que el servidor rechazó">{{ d.failedOps }} con error</span> }
              @if (d.pendingOps > 0) { <span class="vk-badge warn">{{ d.pendingOps }} por enviar</span> }
              @if (d.unauthorized > 0) { <span class="vk-badge brand" matTooltip="Facturas de esta caja que el SRI aún no autoriza">{{ d.unauthorized }} sin autorizar</span> }
              @if (!d.failedOps && !d.pendingOps && !d.unauthorized) { <span class="vk-muted">—</span> }
            </td>
          </ng-container>
          <ng-container matColumnDef="actions">
            <th mat-header-cell *matHeaderCellDef></th>
            <td mat-cell *matCellDef="let d" class="actions">
              <button matIconButton [matMenuTriggerFor]="menu" [attr.aria-label]="'Acciones para ' + d.name"><span class="material-symbols-outlined">more_vert</span></button>
              <mat-menu #menu="matMenu" xPosition="before">
                <button mat-menu-item (click)="ops(d)"><span class="material-symbols-outlined">sync</span><span>Ver sincronización</span></button>
                @if (auth.can('structure.manage')) {
                  <button mat-menu-item (click)="newCode(d)"><span class="material-symbols-outlined">key</span><span>Nuevo código (otra computadora)</span></button>
                  @if (d.status !== 'revoked') {
                    <button mat-menu-item (click)="revoke(d)"><span class="material-symbols-outlined">block</span><span>Revocar</span></button>
                  }
                }
              </mat-menu>
            </td>
          </ng-container>
          <tr mat-header-row *matHeaderRowDef="cols"></tr>
          <tr mat-row *matRowDef="let row; columns: cols"></tr>
          <tr class="mat-row" *matNoDataRow><td class="mat-cell vk-muted empty" [attr.colspan]="cols.length">Todavía no hay cajas de escritorio.</td></tr>
        </table>
      </div>
    </div>
  `,
  styles: `
    .name { font-weight: 600; }
    .vk-badge + .vk-badge { margin-left: 4px; }
    .actions { text-align: right; width: 56px; }
    .empty { padding: 24px 16px; }
  `,
})
export class DevicesPage implements OnInit {
  protected readonly auth = inject(AuthService);
  private readonly http = inject(HttpClient);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(Notify);
  protected readonly devices = signal<DeviceItem[]>([]);
  private readonly establishments = signal<EstablishmentItem[]>([]);
  protected readonly cols = ['name', 'status', 'sync', 'pending', 'actions'];
  private readonly freePoints = computed(() =>
    this.establishments().flatMap((e) =>
      e.emissionPoints
        .filter((p) => p.kind === 'DESKTOP' && p.active && !this.devices().some((d) => d.emissionPointId === p.id))
        .map((p) => ({ id: p.id, label: `${e.code}-${p.code} · ${p.name} (${e.name})` })),
    ),
  );

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  /** Sin contacto en más de 10 minutos = probablemente sin internet. */
  protected stale(d: DeviceItem): boolean {
    return !d.lastSeenAt || Date.now() - new Date(d.lastSeenAt).getTime() > 10 * 60_000;
  }

  private async load(): Promise<void> {
    try {
      const [devices, est] = await Promise.all([
        firstValueFrom(this.http.get<DeviceItem[]>('/api/devices')),
        firstValueFrom(this.http.get<EstablishmentItem[]>('/api/establishments')),
      ]);
      this.devices.set(devices);
      this.establishments.set(est);
    } catch (e) {
      this.notify.error(e);
    }
  }

  private showCode(code: DevicePairingCode): void {
    this.dialog.open(PairingCodeDialog, { data: code, width: 'min(520px, calc(100vw - 32px))' });
  }

  protected async create(): Promise<void> {
    const res = await firstValueFrom(this.dialog.open(NewDeviceDialog, { data: { points: this.freePoints() } }).afterClosed());
    if (!res) return;
    await this.load();
    this.showCode(res);
  }

  protected async newCode(d: DeviceItem): Promise<void> {
    const ok = await this.notify.confirm({
      title: 'Nuevo código de vinculación',
      message: `Úselo para instalar "${d.name}" en otra computadora. La computadora actual dejará de sincronizar en cuanto la nueva se vincule; si tiene ventas sin enviar, conéctela a internet antes.`,
      confirmLabel: 'Generar código',
    });
    if (!ok) return;
    try {
      const res = await firstValueFrom(this.http.post<DevicePairingCode>(`/api/devices/${d.id}/pairing-code`, {}));
      await this.load();
      this.showCode(res);
    } catch (e) {
      this.notify.error(e);
    }
  }

  protected async revoke(d: DeviceItem): Promise<void> {
    const ok = await this.notify.confirm({
      title: 'Revocar caja',
      message: `"${d.name}" dejará de sincronizar de inmediato. Las ventas que tenga sin enviar quedarán en esa computadora hasta que se vuelva a vincular.`,
      confirmLabel: 'Revocar',
      danger: true,
    });
    if (!ok) return;
    try {
      await firstValueFrom(this.http.post(`/api/devices/${d.id}/revoke`, {}));
      this.notify.ok('Caja revocada');
      await this.load();
    } catch (e) {
      this.notify.error(e);
    }
  }

  protected ops(d: DeviceItem): void {
    this.dialog.open(DeviceOpsDialog, { data: { device: d }, width: 'min(680px, calc(100vw - 32px))' });
  }
}
