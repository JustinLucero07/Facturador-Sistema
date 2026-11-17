import { CurrencyPipe, formatCurrency } from '@angular/common';
import { Component, computed, ElementRef, HostListener, inject, OnInit, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router, RouterLink } from '@angular/router';
import type { CashSessionSummary, EInvoiceConfig, IssueInvoiceRequest, ProductSearchItem, QuoteView } from '@vektra/shared-contracts';
import { computeInvoice, distributeDiscount, Totals } from '@vektra/sri-core/calc';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth.service';
import { apiMessage } from '../../core/http';
import { Notify } from '../../core/notify.service';
import { RuntimeService } from '../../core/runtime';
import { ProductPicker } from '../../shared/product-picker';
import { CatalogApi } from '../catalog/catalog.api';
import { EInvoiceApi } from '../einvoice/einvoice.api';
import { CashMovementDialog, CloseCashDialog, OpenCashDialog } from './cash-dialogs';
import { CustomerDialog, FINAL_CONSUMER, PosCustomer } from './customer-dialog';
import { LineEdit, LineEditDialog, QuotesDialog } from './line-dialogs';
import { PaymentDialog, PaymentResult } from './payment-dialog';
import { loadPrefs, PosApi, PosPrefs, savePrefs } from './pos.api';
import { SaleDoneDialog } from './sale-done-dialog';
import { PendingSyncDialog } from './pending-sync-dialog';
import { QuickProductDialog } from './quick-product-dialog';
import { refundMethods, ReturnDialog, ReturnResult } from './return-dialog';
import { printCashReport, printTicket } from './ticket-printer';

export interface CartLine {
  key: string;
  productId: string | null;
  productUnitId: string | null;
  code: string;
  name: string;
  unitLabel: string | null;
  allowsDecimal: boolean;
  quantity: string;
  /** Precio unitario SIN IVA (6 decimales) */
  unitPrice: string;
  discount: string;
  taxRateId: string;
  taxRate: string;
  taxLabel: string;
  stock: string | null;
}

const money = (v: string | number) => formatCurrency(Number(v), 'es-EC', '$', 'USD');
const toCents = (v: string | number) => Math.round(Number(v || 0) * 100);
const pvpOf = (net: string, rate: string) => (Number(net) * (1 + Number(rate) / 100)).toFixed(2);
const netOf = (pvp: string, rate: string) => (Number(pvp) / (1 + Number(rate) / 100)).toFixed(6);

@Component({
  selector: 'vk-pos',
  imports: [FormsModule, MatButtonModule, MatMenuModule, MatTooltipModule, RouterLink, CurrencyPipe, ProductPicker],
  templateUrl: './pos.html',
  styleUrl: './pos.scss',
})
export class PosPage implements OnInit {
  private readonly einvoice = inject(EInvoiceApi);
  private readonly catalog = inject(CatalogApi);
  private readonly api = inject(PosApi);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(Notify);
  protected readonly auth = inject(AuthService);
  protected readonly rt = inject(RuntimeService);
  private readonly router = inject(Router);
  private readonly picker = viewChild(ProductPicker, { read: ElementRef });
  private readonly pickerCmp = viewChild(ProductPicker);
  /** Impresoras del sistema (solo caja de escritorio) */
  protected readonly printers = signal<{ name: string; displayName: string; isDefault: boolean }[]>([]);

  /** Estado de la caja de escritorio: en línea / sin conexión, pendientes y horas restantes. */
  protected readonly syncLabel = computed(() => {
    const i = this.rt.info();
    if (i.mode !== 'desktop') return null;
    const pend = i.pendingOps ?? 0;
    const parts = [i.online ? 'En línea' : 'Sin conexión'];
    if (pend) parts.push(`${pend} por enviar`);
    if (i.failedOps) parts.push(`${i.failedOps} con error`);
    if (!i.online && i.offlineHoursLeft != null) parts.push(`quedan ${Math.floor(i.offlineHoursLeft)} h`);
    return parts.join(' · ');
  });
  protected readonly syncLevel = computed(() => {
    const i = this.rt.info();
    if (i.failedOps || (i.offlineHoursLeft != null && i.offlineHoursLeft < 6)) return 'danger';
    return i.online ? 'ok' : 'warn';
  });

  protected readonly prefs = signal<PosPrefs>(loadPrefs());
  protected readonly config = signal<EInvoiceConfig | null>(null);
  protected readonly session = signal<CashSessionSummary | null>(null);
  protected readonly lines = signal<CartLine[]>([]);
  protected readonly selected = signal<number>(-1);
  protected readonly customer = signal<PosCustomer>(FINAL_CONSUMER);
  protected readonly quoteId = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly canDiscount = this.auth.can('sales.discount');
  protected readonly canQuote = this.auth.can('sales.quote');
  protected readonly canReturn = this.auth.can('sales.void');
  protected readonly defaultWarehouseLabel = signal<string | undefined>(undefined);

  protected readonly emissionPoint = computed(() => this.config()?.emissionPoints.find((p) => p.id === this.prefs().emissionPointId) ?? null);

  protected readonly totals = computed<Totals | null>(() => {
    const ls = this.lines();
    if (!ls.length) return null;
    try {
      return computeInvoice(
        ls.map((l) => ({
          description: l.name,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          discount: l.discount,
          taxes: [{ taxCode: '2', percentageCode: this.rateCode(l.taxRateId), rate: l.taxRate }],
        })),
      ).totals;
    } catch {
      return null;
    }
  });

  protected readonly itemsCount = computed(() => this.lines().reduce((a, l) => a + Number(l.quantity), 0));
  protected readonly overLimit = computed(() => {
    const t = this.totals();
    const cfg = this.config();
    return !!t && !!cfg && this.customer().idType === '07' && Number(t.total) > Number(cfg.finalConsumer.maxAmount);
  });

  async ngOnInit(): Promise<void> {
    if (this.rt.bridge) void this.rt.bridge.printers().then((p) => this.printers.set(p)).catch(() => undefined);
    try {
      const cfg = await this.einvoice.config();
      this.config.set(cfg);
      const prefs = this.prefs();
      if (!prefs.emissionPointId || !cfg.emissionPoints.some((p) => p.id === prefs.emissionPointId)) {
        this.updatePrefs({ emissionPointId: cfg.emissionPoints[0]?.id ?? null });
      }
      await this.loadSession();
    } catch (e) {
      this.notify.error(e);
    }
  }

  private rateCode(taxRateId: string): string {
    return this.config()?.taxRates.find((t) => t.id === taxRateId)?.percentageCode ?? '4';
  }

  protected updatePrefs(p: Partial<PosPrefs>): void {
    const next = { ...this.prefs(), ...p };
    this.prefs.set(next);
    savePrefs(next);
  }

  protected async changePoint(id: string): Promise<void> {
    this.updatePrefs({ emissionPointId: id });
    await this.loadSession();
  }

  private async loadSession(): Promise<void> {
    const ep = this.prefs().emissionPointId;
    if (!ep) return;
    this.session.set(await this.api.currentCash(ep));
  }

  // ───────── Carrito ─────────

  protected pvp(l: CartLine): string {
    return pvpOf(l.unitPrice, l.taxRate);
  }

  protected lineTotal(l: CartLine): string {
    const gross = Number(l.quantity) * Number(l.unitPrice) - Number(l.discount);
    return (gross * (1 + Number(l.taxRate) / 100)).toFixed(2);
  }

  protected add(p: ProductSearchItem): void {
    const unit = p.units.find((u) => u.productUnitId === p.matchedUnitId) ?? p.units.find((u) => u.isBase) ?? p.units[0];
    const ls = [...this.lines()];
    const idx = ls.findIndex((l) => l.productId === p.id && l.productUnitId === (unit?.productUnitId ?? null));
    if (idx >= 0) {
      ls[idx] = { ...ls[idx], quantity: String(Number(ls[idx].quantity) + 1) };
      this.lines.set(ls);
      this.selected.set(idx);
      return;
    }
    const line: CartLine = {
      key: `${p.id}-${unit?.productUnitId}-${Date.now()}`,
      productId: p.id,
      productUnitId: unit?.productUnitId ?? null,
      code: p.code,
      name: unit && !unit.isBase ? `${p.name} (${unit.name} x${+unit.factor})` : p.name,
      unitLabel: unit?.code ?? null,
      allowsDecimal: unit?.allowsDecimal ?? false,
      quantity: '1',
      unitPrice: unit?.price ?? '0',
      discount: '0',
      taxRateId: p.taxRateId,
      taxRate: p.taxRate,
      taxLabel: p.taxLabel,
      stock: p.stock,
    };
    this.lines.set([...ls, line]);
    this.selected.set(ls.length);
    if (!unit?.price || Number(unit.price) === 0) {
      this.notify.error(`"${p.name}" no tiene precio en esta lista`);
      void this.edit(ls.length);
    }
  }

  protected inc(i: number, delta: number): void {
    const ls = [...this.lines()];
    const l = ls[i];
    if (!l) return;
    const q = Number(l.quantity) + delta;
    if (q <= 0) return this.remove(i);
    ls[i] = { ...l, quantity: String(Number(q.toFixed(3))) };
    this.lines.set(ls);
  }

  protected remove(i: number): void {
    this.lines.set(this.lines().filter((_, k) => k !== i));
    this.selected.set(Math.min(i, this.lines().length - 1));
  }

  protected async edit(i: number): Promise<void> {
    const l = this.lines()[i];
    if (!l) return;
    this.selected.set(i);
    const r = await firstValueFrom(
      this.dialog
        .open(LineEditDialog, {
          data: { name: l.name, quantity: l.quantity, pvp: this.pvp(l), discount: l.discount, canDiscount: this.canDiscount, allowsDecimal: l.allowsDecimal },
          autoFocus: false,
        })
        .afterClosed(),
    );
    if (!r) return;
    const edit = r as LineEdit;
    const ls = [...this.lines()];
    const unitPrice = edit.pvp !== this.pvp(l) ? netOf(edit.pvp, l.taxRate) : l.unitPrice;
    const gross = Number(edit.quantity) * Number(unitPrice);
    if (Number(edit.discount) > gross) return this.notify.error('El descuento supera el valor de la línea');
    ls[i] = { ...l, quantity: edit.quantity, unitPrice, discount: Number(edit.discount).toFixed(2) };
    this.lines.set(ls);
  }

  /** Descuento sobre el total (en $ o %), repartido entre las líneas. */
  protected globalDiscount(): void {
    if (!this.canDiscount) return this.notify.error('No tiene permiso para aplicar descuentos');
    const t = this.totals();
    if (!t) return;
    const raw = window.prompt('Descuento al total SIN IVA (ej. 5 para $5, o 10% para porcentaje):', '');
    if (!raw) return;
    const ls = this.lines();
    const gross = ls.map((l) => toCents(Number(l.quantity) * Number(l.unitPrice)));
    const totalGross = gross.reduce((a, b) => a + b, 0);
    const pct = raw.trim().endsWith('%');
    const n = Number(raw.replace('%', '').replace(',', '.'));
    if (!(n > 0)) return;
    const cents = pct ? Math.round((totalGross * n) / 100) : Math.round(n * 100);
    if (cents > totalGross) return this.notify.error('El descuento supera el total');
    const parts = distributeDiscount(gross, cents);
    this.lines.set(ls.map((l, k) => ({ ...l, discount: (parts[k] / 100).toFixed(2) })));
  }

  protected clear(force = false): void {
    if (!force && this.lines().length && !window.confirm('¿Vaciar la venta actual?')) return;
    this.lines.set([]);
    this.selected.set(-1);
    this.customer.set(FINAL_CONSUMER);
    this.quoteId.set(null);
  }

  /** Código escaneado que no existe: alta rápida (si tiene permiso) y se agrega a la venta. */
  protected async notFound(term: string): Promise<void> {
    if (!this.auth.can('catalog.manage')) return this.notify.error(`No se encontró "${term}" en el catálogo`);
    const code = await firstValueFrom(this.dialog.open(QuickProductDialog, { data: { term }, autoFocus: false }).afterClosed());
    if (!code) return;
    this.pickerCmp()?.clear();
    const found = await this.catalog.searchProducts(code, { priceListId: this.customer().priceListId ?? undefined });
    if (found[0]) this.add(found[0]);
    this.notify.ok('Producto creado');
    this.focusSearch();
  }

  /** Devolución: nota de crédito sobre una venta (reembolso en efectivo sale de la caja abierta). */
  protected async returnSale(): Promise<void> {
    if (!this.canReturn) return this.notify.error('No tiene permiso para hacer devoluciones');
    const cfg = this.config();
    const ep = this.emissionPoint();
    if (!cfg || !ep) return;
    const res = (await firstValueFrom(
      this.dialog
        .open(ReturnDialog, {
          data: { emissionPointId: ep.id, cashSessionId: this.session()?.id ?? null, methods: refundMethods(cfg.posPaymentMethods) },
          maxWidth: '96vw',
          autoFocus: 'input',
        })
        .afterClosed(),
    )) as ReturnResult | undefined;
    if (!res) return;
    this.notify.ok(`Nota de crédito ${res.number} por ${money(res.total)}`);
    void this.loadSession();
    try {
      await printTicket(await this.api.ticket(res.documentId), this.prefs().paperWidth);
    } catch (e) {
      this.notify.error(`No se pudo imprimir: ${(e as Error).message}`);
    }
  }

  // ───────── Caja de escritorio ─────────

  protected async syncNow(): Promise<void> {
    try {
      const i = await this.rt.syncNow();
      if (i.online) this.notify.ok(i.pendingOps ? `Sincronizado; quedan ${i.pendingOps} por enviar` : 'Todo sincronizado');
      else this.notify.error('Sin conexión con el servidor. Las ventas se enviarán cuando vuelva el internet.');
    } catch (e) {
      this.notify.error(e);
    }
  }

  protected pending(): void {
    this.dialog.open(PendingSyncDialog, { width: 'min(640px, calc(100vw - 24px))' });
  }

  protected async logout(): Promise<void> {
    if (this.lines().length && !window.confirm('Hay una venta en curso. ¿Cerrar sesión de todas formas?')) return;
    await this.auth.logout();
    await this.router.navigateByUrl('/ingresar');
  }

  // ───────── Cliente ─────────

  protected async chooseCustomer(): Promise<void> {
    const c = await firstValueFrom(this.dialog.open(CustomerDialog, { data: this.customer(), width: 'min(560px, calc(100vw - 32px))' }).afterClosed());
    if (!c) return;
    const before = this.customer().priceListId;
    this.customer.set(c);
    if (c.priceListId !== before && this.lines().length) await this.reprice(c.priceListId);
  }

  /** Cambió la lista de precios del cliente: actualizar precios de las líneas del catálogo. */
  private async reprice(priceListId: string | null): Promise<void> {
    const ls = [...this.lines()];
    for (const [i, l] of ls.entries()) {
      if (!l.productId) continue;
      const found = (await this.catalog.searchProducts(l.code, { priceListId: priceListId ?? undefined })).find((p) => p.id === l.productId);
      const unit = found?.units.find((u) => u.productUnitId === l.productUnitId);
      if (unit?.price) ls[i] = { ...l, unitPrice: unit.price };
    }
    this.lines.set(ls);
    this.notify.ok('Precios actualizados a la lista del cliente');
  }

  // ───────── Cobro ─────────

  protected async charge(): Promise<void> {
    const cfg = this.config();
    const t = this.totals();
    const s = this.session();
    const ep = this.emissionPoint();
    if (!cfg || !t || !ep) return;
    if (!s) return this.notify.error('Abra la caja para vender');
    if (!cfg.certificate.present || cfg.certificate.level === 'danger') return this.notify.error(cfg.certificate.message);
    if (this.overLimit()) return this.notify.error(`Consumidor final: máximo ${money(cfg.finalConsumer.maxAmount)}. Identifique al cliente (F4).`);

    const payments = (await firstValueFrom(
      this.dialog
        .open(PaymentDialog, {
          data: { total: t.total, methods: cfg.posPaymentMethods, identified: this.customer().idType !== '07' && Number(this.customer().creditLimit) > 0 },
          width: 'min(760px, calc(100vw - 24px))',
          maxWidth: '100vw',
                  })
        .afterClosed(),
    )) as PaymentResult[] | undefined;
    if (!payments) return;

    const c = this.customer();
    const body: IssueInvoiceRequest = {
      emissionPointId: ep.id,
      cashSessionId: s.id,
      quoteId: this.quoteId(),
      buyer: { idType: c.idType, id: c.id, name: c.name, email: c.email, phone: c.phone, address: c.address },
      lines: this.lines().map((l) => ({
        productId: l.productId,
        productUnitId: l.productUnitId,
        mainCode: l.code || null,
        description: l.name,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        discount: l.discount,
        taxRateId: l.taxRateId,
      })),
      payments: payments.map((p) => ({ sriCode: p.sriCode, method: p.method, amount: p.amount, cashReceived: p.cashReceived ?? null, reference: p.reference ?? null })),
    };
    this.busy.set(true);
    try {
      const res = await this.einvoice.issue(body);
      this.clear(true);
      this.busy.set(false);
      void this.loadSession();
      await firstValueFrom(
        this.dialog
          .open(SaleDoneDialog, {
            data: { documentId: res.documentId, paperWidth: this.prefs().paperWidth, autoPrint: this.prefs().autoPrint, phone: c.phone, email: c.email },
            disableClose: false,
          })
          .afterClosed(),
      );
      this.focusSearch();
    } catch (e) {
      this.notify.error(apiMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  // ───────── Proformas ─────────

  protected async saveQuote(): Promise<void> {
    const ep = this.emissionPoint();
    if (!ep || !this.lines().length) return;
    const c = this.customer();
    try {
      const q = await this.api.createQuote({
        emissionPointId: ep.id,
        buyer: { idType: c.idType, id: c.id, name: c.name, email: c.email },
        priceListId: c.priceListId,
        lines: this.lines().map((l) => ({
          productId: l.productId,
          productUnitId: l.productUnitId,
          code: l.code,
          description: l.name,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          discount: l.discount,
          taxRateId: l.taxRateId,
          allowsDecimal: l.allowsDecimal,
          unitLabel: l.unitLabel,
        })),
        validDays: 15,
      });
      this.notify.ok(`Proforma N.º ${q.number} guardada por ${money(q.total)} (válida hasta ${q.validUntil})`);
      this.clear(true);
    } catch (e) {
      this.notify.error(e);
    }
  }

  protected async loadQuote(): Promise<void> {
    const q = (await firstValueFrom(this.dialog.open(QuotesDialog, { width: 'min(680px, calc(100vw - 24px))' }).afterClosed())) as QuoteView | undefined;
    if (!q) return;
    const rates = this.config()?.taxRates ?? [];
    this.lines.set(
      q.lines.map((l, i) => {
        const r = rates.find((x) => x.id === l.taxRateId);
        return {
          key: `q${i}-${Date.now()}`,
          productId: l.productId ?? null,
          productUnitId: l.productUnitId ?? null,
          code: l.code ?? '',
          name: l.description,
          unitLabel: l.unitLabel ?? null,
          allowsDecimal: !!l.allowsDecimal,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          discount: l.discount,
          taxRateId: l.taxRateId,
          taxRate: r?.rate ?? '0',
          taxLabel: r?.label ?? '',
          stock: null,
        };
      }),
    );
    this.customer.set(
      q.buyerIdType === '07'
        ? FINAL_CONSUMER
        : { idType: q.buyerIdType as PosCustomer['idType'], id: q.buyerId, name: q.buyerName, email: q.buyerEmail, phone: null, address: null, priceListId: q.priceListId, priceListName: null, creditLimit: '0' },
    );
    this.quoteId.set(q.id);
    if (q.expired) this.notify.error('La proforma está vencida: revise los precios antes de facturar');
  }

  // ───────── Caja ─────────

  protected async openCash(): Promise<void> {
    const ep = this.emissionPoint();
    if (!ep) return;
    const s = await firstValueFrom(this.dialog.open(OpenCashDialog, { data: { emissionPointId: ep.id, label: ep.label } }).afterClosed());
    if (s) {
      this.session.set(s);
      this.focusSearch();
    }
  }

  protected async cashMovement(): Promise<void> {
    const s = this.session();
    if (!s) return;
    const r = await firstValueFrom(this.dialog.open(CashMovementDialog, { data: { sessionId: s.id } }).afterClosed());
    if (r) this.session.set(r);
  }

  protected async partialReport(): Promise<void> {
    const s = this.session();
    if (!s) return;
    const fresh = await this.api.cashSummary(s.id);
    await printCashReport(fresh, this.auth.tenantName(), this.prefs().paperWidth).catch((e: Error) => this.notify.error(`No se pudo imprimir: ${e.message.replace(/^.*Error: /, '')}`));
  }

  protected async closeCash(): Promise<void> {
    const s = this.session();
    if (!s) return;
    if (this.lines().length) return this.notify.error('Termine o vacíe la venta actual antes de cerrar la caja');
    const fresh = await this.api.cashSummary(s.id);
    const closed = await firstValueFrom(this.dialog.open(CloseCashDialog, { data: fresh, width: 'min(820px, calc(100vw - 24px))', maxWidth: '100vw' }).afterClosed());
    if (!closed) return;
    this.session.set(null);
    const diff = Number(closed.difference ?? 0);
    this.notify.ok(diff === 0 ? 'Caja cerrada sin diferencias' : `Caja cerrada con ${diff > 0 ? 'sobrante' : 'faltante'} de ${money(Math.abs(diff))}`);
    await printCashReport(closed, this.auth.tenantName(), this.prefs().paperWidth).catch((e: Error) => this.notify.error(`No se pudo imprimir: ${e.message.replace(/^.*Error: /, '')}`));
  }

  // ───────── Teclado ─────────

  private focusSearch(): void {
    setTimeout(() => (this.picker()?.nativeElement as HTMLElement | undefined)?.querySelector('input')?.focus(), 50);
  }

  @HostListener('document:keydown', ['$event'])
  protected onKey(ev: KeyboardEvent): void {
    if (this.dialog.openDialogs.length) return;
    const typing = (ev.target as HTMLElement)?.tagName === 'INPUT';
    const keys: Record<string, () => void> = {
      F2: () => this.focusSearch(),
      F4: () => void this.chooseCustomer(),
      F8: () => this.globalDiscount(),
      F12: () => void this.charge(),
      F9: () => void this.returnSale(),
    };
    if (keys[ev.key]) {
      ev.preventDefault();
      keys[ev.key]();
      return;
    }
    if (ev.key === 'Escape' && this.lines().length) {
      ev.preventDefault();
      this.clear();
      return;
    }
    if (typing) return;
    const i = this.selected();
    if (ev.key === '+' && i >= 0) this.inc(i, 1);
    else if (ev.key === '-' && i >= 0) this.inc(i, -1);
    else if (ev.key === 'Delete' && i >= 0) this.remove(i);
    else if (ev.key === 'ArrowDown') this.selected.set(Math.min(i + 1, this.lines().length - 1));
    else if (ev.key === 'ArrowUp') this.selected.set(Math.max(i - 1, 0));
    else if (ev.key === 'Enter' && i >= 0) void this.edit(i);
  }
}
