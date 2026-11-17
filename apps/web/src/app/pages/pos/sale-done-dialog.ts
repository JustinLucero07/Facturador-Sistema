import { CurrencyPipe } from '@angular/common';
import { Component, HostListener, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { EDOC_STATUS_LABELS, type EDocStatusCode, type TicketData } from '@vektra/shared-contracts';
import { Notify } from '../../core/notify.service';
import { EInvoiceApi } from '../einvoice/einvoice.api';
import { PosApi, whatsappNumber } from './pos.api';
import { printTicket } from './ticket-printer';

/** Venta registrada: imprimir ticket, enviar por correo o WhatsApp. Enter = nueva venta. */
@Component({
  selector: 'vk-sale-done',
  imports: [MatDialogModule, MatButtonModule, CurrencyPipe],
  template: `
    <div class="done">
      <span class="material-symbols-outlined icon">check_circle</span>
      <h2>Venta registrada</h2>
      @if (t(); as t) {
        <p class="num">Factura {{ t.number }}</p>
        <p class="total">{{ t.total | currency }}</p>
        @for (p of t.payments; track $index) {
          @if (p.change && +p.change > 0) { <p class="change">Cambio: {{ p.change | currency }}</p> }
        }
        <p class="vk-muted small">SRI: {{ statusLabel() }}</p>
      } @else {
        <p class="vk-muted">Preparando ticket…</p>
      }
    </div>
    <mat-dialog-actions class="actions">
      <button matButton="outlined" (click)="print()" [disabled]="!t()"><span class="material-symbols-outlined">print</span> Imprimir (P)</button>
      <button matButton="outlined" (click)="email()" [disabled]="!t()"><span class="material-symbols-outlined">mail</span> Correo</button>
      <button matButton="outlined" (click)="whatsapp()" [disabled]="!t()"><span class="material-symbols-outlined">chat</span> WhatsApp</button>
      <button matButton="filled" class="next" (click)="next()" cdkFocusInitial>Nueva venta (Enter)</button>
    </mat-dialog-actions>
  `,
  styles: `
    .done { text-align: center; padding: 24px 32px 8px; min-width: 320px; }
    .icon { font-size: 64px; color: var(--vk-success); font-variation-settings: 'FILL' 1; }
    h2 { margin: 4px 0; font: var(--mat-sys-headline-small); }
    .num { margin: 0; font-family: ui-monospace, monospace; } .total { font-weight: 700; font-size: 34px; line-height: 1.2; font-family: inherit; margin: 8px 0 0; }
    .change { font-weight: 700; font-size: 26px; line-height: 1.2; font-family: inherit; color: var(--vk-success); margin: 4px 0; } .small { font: var(--mat-sys-body-small); }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; padding: 16px; }
    .next { min-height: 48px; padding: 0 24px; }
  `,
})
export class SaleDoneDialog implements OnInit, OnDestroy {
  private readonly data = inject<{ documentId: string; paperWidth: 58 | 80; autoPrint: boolean; phone: string | null; email: string | null }>(MAT_DIALOG_DATA);
  private readonly api = inject(PosApi);
  private readonly einvoice = inject(EInvoiceApi);
  private readonly notify = inject(Notify);
  private readonly ref = inject(MatDialogRef<SaleDoneDialog>);
  protected readonly t = signal<TicketData | null>(null);
  protected readonly status = signal<EDocStatusCode | null>(null);
  private timer: ReturnType<typeof setInterval> | undefined;

  protected statusLabel(): string {
    const s = this.status();
    return s ? EDOC_STATUS_LABELS[s] : '…';
  }

  async ngOnInit(): Promise<void> {
    try {
      const t = await this.api.ticket(this.data.documentId);
      this.t.set(t);
      this.status.set(t.status as EDocStatusCode);
      if (this.data.autoPrint) void this.print();
    } catch (e) {
      this.notify.error(e);
    }
    this.timer = setInterval(async () => {
      const d = await this.einvoice.detail(this.data.documentId).catch(() => null);
      if (d) this.status.set(d.status);
      if (d && !['SIGNED', 'SENT', 'RECEIVED'].includes(d.status)) clearInterval(this.timer);
    }, 2500);
  }

  ngOnDestroy(): void {
    clearInterval(this.timer);
  }

  @HostListener('document:keydown', ['$event'])
  protected onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      this.next();
    } else if (ev.key.toLowerCase() === 'p') {
      ev.preventDefault();
      void this.print();
    }
  }

  protected async print(): Promise<void> {
    const t = this.t();
    if (!t) return;
    try {
      await printTicket(t, this.data.paperWidth);
    } catch (e) {
      this.notify.error(`No se pudo imprimir el ticket: ${(e as Error).message.replace(/^.*Error: /, '')}. Revise la impresora (menú de impresión).`);
    }
  }

  protected async email(): Promise<void> {
    const to = window.prompt('Correo del cliente:', this.data.email ?? '');
    if (!to) return;
    try {
      await this.einvoice.email(this.data.documentId, to.trim());
      this.notify.ok('Se enviará el XML y el RIDE cuando el SRI autorice');
    } catch (e) {
      this.notify.error(e);
    }
  }

  protected whatsapp(): void {
    const t = this.t();
    if (!t) return;
    let number = whatsappNumber(this.data.phone);
    if (!number) {
      const typed = window.prompt('WhatsApp del cliente (ej. 0991234567):', '');
      number = whatsappNumber(typed);
      if (!number) return this.notify.error('Número de celular inválido');
    }
    const text = `Hola, gracias por su compra en ${t.company.tradeName ?? t.company.legalName}. Su factura ${t.number} por $${t.total}: ${t.publicRideUrl}`;
    window.open(`https://wa.me/${number}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  }

  protected next(): void {
    this.ref.close(true);
  }
}
