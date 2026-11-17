import { DatePipe } from '@angular/common';
import { Component, inject, OnInit, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule } from '@angular/material/dialog';
import { Notify } from '../../core/notify.service';
import { RuntimeService } from '../../core/runtime';

const LABELS: Record<string, string> = {
  'invoice.issue': 'Factura',
  'cash.open': 'Apertura de caja',
  'cash.movement': 'Ingreso/egreso de caja',
  'cash.close': 'Cierre de caja',
  'party.upsert': 'Cliente',
  'product.create': 'Producto nuevo',
  'quote.create': 'Proforma',
  'document.email': 'Envío por correo',
};

/** Caja de escritorio: lo que aún no llega al servidor y lo que el servidor rechazó. */
@Component({
  selector: 'vk-pending-sync',
  imports: [MatDialogModule, MatButtonModule, DatePipe],
  template: `
    <h2 mat-dialog-title>Pendientes de sincronizar</h2>
    <mat-dialog-content>
      @if (rt.info().lastSyncAt) {
        <p class="vk-muted">Última sincronización: {{ rt.info().lastSyncAt | date: 'short' }}</p>
      }
      @for (o of items(); track o.id) {
        <div class="op" [class.bad]="o.status === 'rejected'">
          <strong>{{ label(o.type) }}</strong>
          <span class="vk-muted"> · {{ o.clientAt | date: 'short' }} · {{ o.status === 'rejected' ? 'rechazada' : 'por enviar' }}</span>
          @if (o.message) { <div class="msg">{{ o.message }}</div> }
        </div>
      } @empty {
        <p>Todo está sincronizado.</p>
      }
      @if (hasRejected()) {
        <p class="vk-muted small">Las operaciones rechazadas no se reintentan: revise el detalle con el administrador en la web (Cajas de escritorio → Ver sincronización).</p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton (click)="sync()">Sincronizar ahora</button>
      <button matButton="filled" mat-dialog-close>Cerrar</button>
    </mat-dialog-actions>
  `,
  styles: `
    .op { padding: 8px 0; border-bottom: 1px solid var(--mat-sys-outline-variant); }
    .bad strong, .msg { color: var(--vk-danger); }
    .msg { font: var(--mat-sys-body-small); }
    .small { font: var(--mat-sys-body-small); }
  `,
})
export class PendingSyncDialog implements OnInit {
  protected readonly rt = inject(RuntimeService);
  private readonly notify = inject(Notify);
  protected readonly items = signal<{ id: string; type: string; status: string; message: string | null; clientAt: string }[]>([]);
  protected readonly hasRejected = () => this.items().some((i) => i.status === 'rejected');
  protected readonly label = (t: string) => LABELS[t] ?? t;

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  private async load(): Promise<void> {
    try {
      this.items.set(await this.rt.outbox());
    } catch (e) {
      this.notify.error(e);
    }
  }

  protected async sync(): Promise<void> {
    await this.rt.syncNow().catch(() => undefined);
    await this.load();
  }
}
