import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { AtsPreview, ReportKind, ReportResult } from '@vektra/shared-contracts';
import { firstValueFrom } from 'rxjs';

export interface ReportParams {
  kind: ReportKind;
  from: string;
  to: string;
  warehouseId?: string | null;
}

@Injectable({ providedIn: 'root' })
export class ReportsApi {
  private readonly http = inject(HttpClient);

  private params(p: ReportParams, format: 'json' | 'xlsx') {
    return { kind: p.kind, from: p.from, to: p.to, format, ...(p.warehouseId ? { warehouseId: p.warehouseId } : {}) };
  }

  run = (p: ReportParams) => firstValueFrom(this.http.get<ReportResult>('/api/reports', { params: this.params(p, 'json') }));
  excel = (p: ReportParams) => firstValueFrom(this.http.get('/api/reports', { params: this.params(p, 'xlsx'), responseType: 'blob' }));
  ats = (year: number, month: number, semiannual: boolean) =>
    firstValueFrom(this.http.get<AtsPreview>('/api/reports/ats', { params: { year, month, semiannual: String(semiannual), format: 'json' } }));
  atsFile = (year: number, month: number, semiannual: boolean, format: 'xml' | 'zip') =>
    firstValueFrom(this.http.get('/api/reports/ats', { params: { year, month, semiannual: String(semiannual), format }, responseType: 'blob' }));
}

export interface ReportDef {
  kind: ReportKind;
  label: string;
  icon: string;
  group: string;
  /** Reporte "a hoy": no usa el rango de fechas */
  snapshot?: boolean;
  warehouse?: boolean;
  permission: 'reports.read' | 'reports.tax';
}

export const REPORTS: ReportDef[] = [
  { kind: 'sales_daily', label: 'Ventas por día', icon: 'calendar_month', group: 'Ventas', permission: 'reports.read' },
  { kind: 'sales_product', label: 'Ventas por producto', icon: 'inventory_2', group: 'Ventas', permission: 'reports.read' },
  { kind: 'sales_category', label: 'Ventas por categoría', icon: 'category', group: 'Ventas', permission: 'reports.read' },
  { kind: 'sales_user', label: 'Ventas por cajero', icon: 'badge', group: 'Ventas', permission: 'reports.read' },
  { kind: 'sales_payment', label: 'Ventas por forma de pago', icon: 'payments', group: 'Ventas', permission: 'reports.read' },
  { kind: 'profit', label: 'Utilidad por producto', icon: 'trending_up', group: 'Ventas', permission: 'reports.read' },
  { kind: 'cash_sessions', label: 'Cierres de caja', icon: 'point_of_sale', group: 'Ventas', permission: 'reports.read' },
  { kind: 'inventory', label: 'Inventario valorizado', icon: 'warehouse', group: 'Inventario y compras', snapshot: true, warehouse: true, permission: 'reports.read' },
  { kind: 'purchases_supplier', label: 'Compras por proveedor', icon: 'local_shipping', group: 'Inventario y compras', permission: 'reports.read' },
  { kind: 'receivables', label: 'Cartera por cobrar', icon: 'request_quote', group: 'Cuentas', snapshot: true, permission: 'reports.read' },
  { kind: 'payables', label: 'Cuentas por pagar', icon: 'account_balance_wallet', group: 'Cuentas', snapshot: true, permission: 'reports.read' },
  { kind: 'vat', label: 'Resumen de IVA y retenciones', icon: 'percent', group: 'Tributario', permission: 'reports.tax' },
];

/** Fecha local (Ecuador) en AAAA-MM-DD. */
export function localDate(d = new Date()): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
}
