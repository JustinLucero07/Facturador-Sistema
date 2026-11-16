import { CurrencyPipe, DatePipe } from '@angular/common';
import { Component, computed, inject, input, OnDestroy, OnInit, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterLink } from '@angular/router';
import { EDOC_STATUS_LABELS, type EDocDetail, type EDocStatusCode } from '@vektra/shared-contracts';
import { AuthService } from '../../core/auth.service';
import { Notify } from '../../core/notify.service';
import { EInvoiceApi, openBlob, STATUS_CLASS } from './einvoice.api';

const IN_PROGRESS: EDocStatusCode[] = ['SIGNED', 'SENT', 'RECEIVED', 'CONTINGENCY'];

@Component({
  selector: 'vk-document-detail',
  imports: [DatePipe, CurrencyPipe, MatButtonModule, MatTooltipModule, RouterLink],
  templateUrl: './document-detail.html',
  styleUrl: './document-detail.scss',
})
export class DocumentDetailPage implements OnInit, OnDestroy {
  private readonly api = inject(EInvoiceApi);
  private readonly notify = inject(Notify);
  protected readonly auth = inject(AuthService);
  /** :id de la ruta */
  readonly id = input.required<string>();
  protected readonly doc = signal<EDocDetail | null>(null);
  protected readonly statusClass = STATUS_CLASS;
  protected readonly busy = signal(false);
  protected readonly inProgress = computed(() => !!this.doc() && IN_PROGRESS.includes(this.doc()!.status));
  protected readonly canRetry = computed(() => {
    const d = this.doc();
    return !!d && ['RETURNED', 'NOT_AUTHORIZED', 'CONTINGENCY', 'SIGNED'].includes(d.status);
  });
  private timer: ReturnType<typeof setInterval> | undefined;

  ngOnInit(): void {
    void this.load();
    this.timer = setInterval(() => {
      if (this.inProgress() || this.doc()?.emailStatus === 'PENDING') void this.load();
    }, 3000);
  }

  ngOnDestroy(): void {
    clearInterval(this.timer);
  }

  protected label(s: EDocStatusCode | null): string {
    return s ? EDOC_STATUS_LABELS[s] : '—';
  }

  private async load(): Promise<void> {
    try {
      this.doc.set(await this.api.detail(this.id()));
    } catch (e) {
      this.notify.error(e);
      clearInterval(this.timer);
    }
  }

  protected async download(kind: 'xml' | 'ride'): Promise<void> {
    const d = this.doc();
    if (!d) return;
    try {
      const blob = await this.api.file(d.id, kind);
      openBlob(blob, kind === 'xml' ? `${d.accessKey}.xml` : `RIDE-${d.number}.pdf`, kind === 'ride');
    } catch (e) {
      this.notify.error(e);
    }
  }

  protected async retry(): Promise<void> {
    this.busy.set(true);
    try {
      await this.api.retry(this.id());
      this.notify.ok('Comprobante reenviado al SRI');
      await this.load();
    } catch (e) {
      this.notify.error(e);
    } finally {
      this.busy.set(false);
    }
  }

  protected async resendEmail(): Promise<void> {
    const current = this.doc()?.buyerEmail ?? '';
    const email = window.prompt('Correo al que se enviará el XML y el RIDE:', current);
    if (email === null) return;
    try {
      await this.api.email(this.id(), email.trim() || undefined);
      this.notify.ok('Envío de correo programado');
      await this.load();
    } catch (e) {
      this.notify.error(e);
    }
  }

  protected copy(text: string): void {
    void navigator.clipboard?.writeText(text).then(() => this.notify.ok('Clave de acceso copiada'));
  }
}
