import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { CashMovementRequest, CashSessionSummary, CloseCashRequest, Paginated, QuoteRequest, QuoteView, TicketData } from '@vektra/shared-contracts';
import { firstValueFrom } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class PosApi {
  private readonly http = inject(HttpClient);
  currentCash = (emissionPointId: string) => firstValueFrom(this.http.get<CashSessionSummary | null>('/api/cash/current', { params: { emissionPointId } }));
  openCash = (emissionPointId: string, openingAmount: string) => firstValueFrom(this.http.post<CashSessionSummary>('/api/cash/sessions', { emissionPointId, openingAmount }));
  cashSummary = (id: string) => firstValueFrom(this.http.get<CashSessionSummary>(`/api/cash/sessions/${id}`));
  cashMovement = (id: string, body: CashMovementRequest) => firstValueFrom(this.http.post<CashSessionSummary>(`/api/cash/sessions/${id}/movements`, body));
  closeCash = (id: string, body: CloseCashRequest) => firstValueFrom(this.http.post<CashSessionSummary>(`/api/cash/sessions/${id}/close`, body));
  cashSessions = (page: number, pageSize: number) => firstValueFrom(this.http.get<Paginated<CashSessionSummary>>('/api/cash/sessions', { params: { page, pageSize } }));
  ticket = (documentId: string) => firstValueFrom(this.http.get<TicketData>(`/api/pos/tickets/${documentId}`));
  createQuote = (body: QuoteRequest) => firstValueFrom(this.http.post<QuoteView>('/api/quotes', body));
  quotes = (search = '') => firstValueFrom(this.http.get<Paginated<QuoteView>>('/api/quotes', { params: { pending: 'true', pageSize: 50, ...(search ? { search } : {}) } }));
  quote = (id: string) => firstValueFrom(this.http.get<QuoteView>(`/api/quotes/${id}`));
}

/** Preferencias de este equipo (no se comparten entre cajas). */
export interface PosPrefs {
  emissionPointId: string | null;
  paperWidth: 58 | 80;
  autoPrint: boolean;
  /** Caja de escritorio: impresora térmica (null = la predeterminada del sistema) */
  printerName: string | null;
}

const KEY = 'vk_pos_prefs';

export function loadPrefs(): PosPrefs {
  try {
    return { emissionPointId: null, paperWidth: 80, autoPrint: true, printerName: null, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { emissionPointId: null, paperWidth: 80, autoPrint: true, printerName: null };
  }
}

export function savePrefs(p: PosPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* navegación privada */
  }
}

/** Número de WhatsApp de Ecuador: 0991234567 → 593991234567 */
export function whatsappNumber(phone: string | null | undefined): string | null {
  const d = (phone ?? '').replace(/\D/g, '');
  if (/^09\d{8}$/.test(d)) return `593${d.slice(1)}`;
  if (/^5939\d{8}$/.test(d)) return d;
  return null;
}
