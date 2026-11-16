import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  CertificateStatus,
  EDocDetail,
  EDocListItem,
  EDocStatusCode,
  EInvoiceConfig,
  IssueInvoiceRequest,
  MailConfigRequest,
  MailConfigView,
  Paginated,
  TaxRateItem,
  TaxRateRequest,
} from '@vektra/shared-contracts';
import { firstValueFrom } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class EInvoiceApi {
  private readonly http = inject(HttpClient);

  config = () => firstValueFrom(this.http.get<EInvoiceConfig>('/api/einvoice/config'));
  issue = (body: IssueInvoiceRequest) =>
    firstValueFrom(this.http.post<{ documentId: string; number: string; accessKey: string; total: string }>('/api/einvoice/invoices', body));

  list(q: { status?: EDocStatusCode | ''; search?: string; page: number; pageSize: number }) {
    let params = new HttpParams().set('page', q.page).set('pageSize', q.pageSize);
    if (q.status) params = params.set('status', q.status);
    if (q.search) params = params.set('search', q.search);
    return firstValueFrom(this.http.get<Paginated<EDocListItem>>('/api/einvoice/documents', { params }));
  }

  detail = (id: string) => firstValueFrom(this.http.get<EDocDetail>(`/api/einvoice/documents/${id}`));
  retry = (id: string) => firstValueFrom(this.http.post<{ queued: string }>(`/api/einvoice/documents/${id}/retry`, {}));
  email = (id: string, email?: string) => firstValueFrom(this.http.post(`/api/einvoice/documents/${id}/email`, email ? { email } : {}));
  file = (id: string, kind: 'xml' | 'ride') => firstValueFrom(this.http.get(`/api/einvoice/documents/${id}/${kind}`, { responseType: 'blob' }));

  certificate = () => firstValueFrom(this.http.get<CertificateStatus>('/api/einvoice/certificate'));
  uploadCertificate(file: File, password: string) {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('password', password);
    return firstValueFrom(this.http.post<CertificateStatus>('/api/einvoice/certificate', fd));
  }

  mailConfig = () => firstValueFrom(this.http.get<MailConfigView | null>('/api/einvoice/mail-config'));
  saveMailConfig = (body: MailConfigRequest) => firstValueFrom(this.http.put('/api/einvoice/mail-config', body));
  testMail = (to: string) => firstValueFrom(this.http.post('/api/einvoice/mail-config/test', { to }));

  taxRates = () => firstValueFrom(this.http.get<TaxRateItem[]>('/api/tax/rates'));
  createTaxRate = (body: TaxRateRequest) => firstValueFrom(this.http.post('/api/tax/rates', body));
  updateTaxRate = (id: string, body: TaxRateRequest) => firstValueFrom(this.http.patch(`/api/tax/rates/${id}`, body));
  settings = () => firstValueFrom(this.http.get<{ key: string; value: unknown; note: string | null; supportOnly: boolean }[]>('/api/tax/settings'));
  updateSetting = (key: string, value: unknown) => firstValueFrom(this.http.put(`/api/tax/settings/${key}`, { value }));
}

/** Descarga o abre un Blob con nombre de archivo. */
export function openBlob(blob: Blob, fileName: string, inline = false): void {
  const url = URL.createObjectURL(blob);
  if (inline) {
    window.open(url, '_blank', 'noopener');
  } else {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const STATUS_CLASS: Record<EDocStatusCode, string> = {
  DRAFT: '',
  SIGNED: 'brand',
  SENT: 'brand',
  RECEIVED: 'brand',
  RETURNED: 'danger',
  AUTHORIZED: 'ok',
  NOT_AUTHORIZED: 'danger',
  CONTINGENCY: 'warn',
  PENDING_SYNC: 'warn',
  REJECTED_SYNC: 'danger',
};
