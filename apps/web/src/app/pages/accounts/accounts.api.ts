import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  AccountPaymentRequest,
  AccountsOverview,
  AccountSide,
  AccountStatement,
  OpeningItemRequest,
  ReceivedWithholdingPreview,
  ReceivedWithholdingRequest,
} from '@vektra/shared-contracts';
import { firstValueFrom } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class AccountsApi {
  private readonly http = inject(HttpClient);

  overview = (side: AccountSide, p: { search?: string; overdue?: boolean; page: number; pageSize: number }) =>
    firstValueFrom(
      this.http.get<AccountsOverview>(`/api/accounts/${side}`, {
        params: { page: p.page, pageSize: p.pageSize, ...(p.search ? { search: p.search } : {}), ...(p.overdue ? { overdue: 'true' } : {}) },
      }),
    );
  statement = (side: AccountSide, partyId: string) => firstValueFrom(this.http.get<AccountStatement>(`/api/accounts/${side}/parties/${partyId}`));
  pay = (side: AccountSide, body: AccountPaymentRequest) => firstValueFrom(this.http.post<{ id: string; unapplied: string }>(`/api/accounts/${side}/payments`, body));
  opening = (side: AccountSide, body: OpeningItemRequest) => firstValueFrom(this.http.post<{ id: string }>(`/api/accounts/${side}/openings`, body));
  applyCredit = (side: AccountSide, body: { movementId: string; itemId: string; amount: string }) => firstValueFrom(this.http.post(`/api/accounts/${side}/apply-credit`, body));
  voidMovement = (side: AccountSide, id: string, reason: string) => firstValueFrom(this.http.post(`/api/accounts/${side}/movements/${id}/void`, { reason }));
  withholdingPreview = (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return firstValueFrom(this.http.post<ReceivedWithholdingPreview>('/api/accounts/AR/withholdings/xml-preview', fd));
  };
  withholding = (body: ReceivedWithholdingRequest) => firstValueFrom(this.http.post<{ id: string }>('/api/accounts/AR/withholdings', body));
}

export const SIDE_TEXT = {
  AR: { title: 'Cuentas por cobrar', party: 'Cliente', parties: 'clientes', pay: 'Registrar cobro', payNoun: 'Cobro', owedLabel: 'Por cobrar', link: '/cuentas/cobrar' },
  AP: { title: 'Cuentas por pagar', party: 'Proveedor', parties: 'proveedores', pay: 'Registrar pago', payNoun: 'Pago', owedLabel: 'Por pagar', link: '/cuentas/pagar' },
} as const;

export const KIND_LABEL: Record<string, string> = {
  PAYMENT: 'Pago',
  WITHHOLDING: 'Retención',
  CREDIT_NOTE: 'Nota de crédito',
  ADVANCE: 'Anticipo',
};

export const todayEc = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
