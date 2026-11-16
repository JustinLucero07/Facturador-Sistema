import { CurrencyPipe } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormArray, FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router, RouterLink } from '@angular/router';
import type { EInvoiceConfig, IssueInvoiceRequest } from '@vektra/shared-contracts';
import { validateCedula, validateRuc } from '@vektra/shared-domain';
import { computeInvoice, Totals } from '@vektra/sri-core/calc';
import { startWith } from 'rxjs';
import { apiMessage } from '../../core/http';
import { Notify } from '../../core/notify.service';
import { FieldError } from '../../shared/field-error';
import { EInvoiceApi } from './einvoice.api';
import { ProductPicker } from '../../shared/product-picker';
import { CatalogApi } from '../catalog/catalog.api';
import type { ProductSearchItem } from '@vektra/shared-contracts';
import { HttpErrorResponse } from '@angular/common/http';

type LineForm = FormGroup<{
  productId: FormControl<string | null>;
  productUnitId: FormControl<string | null>;
  unitLabel: FormControl<string>;
  mainCode: FormControl<string>;
  description: FormControl<string>;
  quantity: FormControl<string>;
  unitPrice: FormControl<string>;
  discount: FormControl<string>;
  taxRateId: FormControl<string>;
}>;

type PaymentForm = FormGroup<{ sriCode: FormControl<string>; method: FormControl<string>; amount: FormControl<string> }>;

const METHODS = [
  { value: 'efectivo', label: 'Efectivo', sriCode: '01' },
  { value: 'tarjeta_debito', label: 'Tarjeta de débito', sriCode: '16' },
  { value: 'tarjeta_credito', label: 'Tarjeta de crédito', sriCode: '19' },
  { value: 'transferencia', label: 'Transferencia', sriCode: '20' },
  { value: 'deuna', label: 'Deuna', sriCode: '20' },
  { value: 'payphone', label: 'Payphone', sriCode: '19' },
  { value: 'credito', label: 'Crédito (cuenta por cobrar)', sriCode: '20' },
];

/**
 * Emisión de factura (Fase 1). En la Fase 3 el POS reemplaza este formulario con búsqueda de productos
 * y clientes; el cálculo usa el mismo módulo que el servidor (@vektra/sri-core/calc).
 */
@Component({
  selector: 'vk-new-invoice',
  imports: [ReactiveFormsModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule, MatButtonToggleModule, MatTooltipModule, CurrencyPipe, RouterLink, FieldError, ProductPicker],
  templateUrl: './new-invoice.html',
  styleUrl: './new-invoice.scss',
})
export class NewInvoicePage implements OnInit {
  private readonly api = inject(EInvoiceApi);
  private readonly notify = inject(Notify);
  private readonly router = inject(Router);
  private readonly catalog = inject(CatalogApi);
  protected readonly customerPriceListId = signal<string | undefined>(undefined);
  protected readonly customerFound = signal<string | null>(null);

  protected readonly config = signal<EInvoiceConfig | null>(null);
  protected readonly saving = signal(false);
  protected readonly errorDetails = signal<string[]>([]);
  protected readonly methods = METHODS;

  protected readonly form = new FormGroup({
    emissionPointId: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    customerKind: new FormControl<'final' | 'identified'>('final', { nonNullable: true }),
    buyer: new FormGroup({
      idType: new FormControl('05', { nonNullable: true }),
      id: new FormControl('', { nonNullable: true }),
      name: new FormControl('', { nonNullable: true }),
      email: new FormControl('', { nonNullable: true, validators: [Validators.email] }),
      phone: new FormControl('', { nonNullable: true }),
      address: new FormControl('', { nonNullable: true }),
    }),
    lines: new FormArray<LineForm>([]),
    payments: new FormArray<PaymentForm>([]),
  });

  private readonly formValue = toSignal(this.form.valueChanges.pipe(startWith(null)));

  /** Totales en vivo con el mismo algoritmo del servidor. */
  protected readonly preview = computed<{ totals: Totals | null; error: string | null }>(() => {
    this.formValue();
    const cfg = this.config();
    if (!cfg) return { totals: null, error: null };
    try {
      const lines = this.form.controls.lines.controls
        .map((l) => l.getRawValue())
        .filter((l) => l.description && l.quantity && l.unitPrice);
      if (!lines.length) return { totals: null, error: null };
      const r = computeInvoice(
        lines.map((l) => {
          const rate = cfg.taxRates.find((t) => t.id === l.taxRateId);
          return {
            description: l.description,
            quantity: l.quantity.replace(',', '.'),
            unitPrice: l.unitPrice.replace(',', '.'),
            discount: (l.discount || '0').replace(',', '.'),
            taxes: rate ? [{ taxCode: rate.taxCode, percentageCode: rate.percentageCode, rate: rate.rate }] : [],
          };
        }),
      );
      return { totals: r.totals, error: null };
    } catch (e) {
      return { totals: null, error: (e as Error).message };
    }
  });

  protected readonly paid = computed(() => {
    this.formValue();
    return this.form.controls.payments.controls.reduce((s, p) => s + (Number(p.controls.amount.value.replace(',', '.')) || 0), 0);
  });

  protected readonly overFinalConsumerLimit = computed(() => {
    const t = this.preview().totals;
    const cfg = this.config();
    return !!t && !!cfg && this.form.controls.customerKind.value === 'final' && Number(t.total) > Number(cfg.finalConsumer.maxAmount);
  });

  async ngOnInit(): Promise<void> {
    try {
      const cfg = await this.api.config();
      this.config.set(cfg);
      if (cfg.emissionPoints[0]) this.form.controls.emissionPointId.setValue(cfg.emissionPoints[0].id);
      this.addLine();
      this.addPayment();
    } catch (e) {
      this.notify.error(e);
    }
  }

  protected groupLabel(percentageCode: string): string {
    return this.config()?.taxRates.find((t) => t.percentageCode === percentageCode)?.label ?? percentageCode;
  }

  protected lineTotal(l: LineForm): string {
    const v = l.getRawValue();
    const n = Number(v.quantity.replace(',', '.')) * Number(v.unitPrice.replace(',', '.')) - Number((v.discount || '0').replace(',', '.'));
    return Number.isFinite(n) ? n.toFixed(2) : '0.00';
  }

  protected addLine(seed: Partial<{ productId: string; productUnitId: string; unitLabel: string; mainCode: string; description: string; unitPrice: string; taxRateId: string }> = {}): void {
    const defaultRate = this.config()?.taxRates.find((t) => t.percentageCode === '4')?.id ?? this.config()?.taxRates[0]?.id ?? '';
    this.form.controls.lines.push(
      new FormGroup({
        productId: new FormControl<string | null>(seed.productId ?? null),
        productUnitId: new FormControl<string | null>(seed.productUnitId ?? null),
        unitLabel: new FormControl(seed.unitLabel ?? '', { nonNullable: true }),
        mainCode: new FormControl(seed.mainCode ?? '', { nonNullable: true }),
        description: new FormControl(seed.description ?? '', { nonNullable: true, validators: [Validators.required, Validators.maxLength(300)] }),
        quantity: new FormControl('1', { nonNullable: true, validators: [Validators.required, Validators.pattern(/^\d+([.,]\d{1,6})?$/)] }),
        unitPrice: new FormControl(seed.unitPrice ?? '', { nonNullable: true, validators: [Validators.required, Validators.pattern(/^\d+([.,]\d{1,6})?$/)] }),
        discount: new FormControl('', { nonNullable: true, validators: [Validators.pattern(/^(\d+([.,]\d{1,2})?)?$/)] }),
        taxRateId: new FormControl(seed.taxRateId ?? defaultRate, { nonNullable: true, validators: [Validators.required] }),
      }),
    );
  }

  /** Producto elegido en el buscador (o escaneado): agrega una línea con su precio e IVA. */
  protected addProduct(p: ProductSearchItem): void {
    const unit = p.units.find((u) => u.productUnitId === p.matchedUnitId) ?? p.units.find((u) => u.isBase) ?? p.units[0];
    const lines = this.form.controls.lines;
    // Mismo producto y presentación: sumar 1 en lugar de duplicar la línea
    const same = lines.controls.find((l) => l.controls.productId.value === p.id && l.controls.productUnitId.value === (unit?.productUnitId ?? null));
    if (same) {
      same.controls.quantity.setValue(String(Number(same.controls.quantity.value.replace(',', '.')) + 1));
      return;
    }
    const empty = lines.controls.findIndex((l) => !l.controls.description.value && !l.controls.unitPrice.value);
    if (empty >= 0) lines.removeAt(empty);
    this.addLine({
      productId: p.id,
      productUnitId: unit?.productUnitId,
      unitLabel: unit && !unit.isBase ? unit.name : '',
      mainCode: p.code,
      description: unit && !unit.isBase ? `${p.name} (${unit.name} x${+unit.factor})` : p.name,
      unitPrice: unit?.price ? String(Number(unit.price)) : '',
      taxRateId: p.taxRateId,
    });
    if (!unit?.price) this.notify.error(`"${p.name}" no tiene precio en esta lista: ingréselo`);
  }

  /** Busca el cliente registrado por su identificación y completa sus datos. */
  protected async lookupCustomer(): Promise<void> {
    const b = this.form.controls.buyer.controls;
    const id = b.id.value.trim();
    if (id.length < 5) return;
    try {
      const party = await this.catalog.partyByIdentification(id);
      if (!party) {
        this.customerFound.set(null);
        this.customerPriceListId.set(undefined);
        return;
      }
      b.idType.setValue(party.idType);
      b.name.setValue(party.name);
      if (party.email) b.email.setValue(party.email.split(/[;,]/)[0].trim());
      if (party.phone) b.phone.setValue(party.phone);
      if (party.address) b.address.setValue(party.address);
      this.customerFound.set(party.priceListName ? `Cliente registrado · lista ${party.priceListName}` : 'Cliente registrado');
      this.customerPriceListId.set(party.priceListId ?? undefined);
    } catch {
      /* sin conexión al catálogo: se ingresa a mano */
    }
  }

  protected removeLine(i: number): void {
    this.form.controls.lines.removeAt(i);
  }

  protected addPayment(): void {
    this.form.controls.payments.push(
      new FormGroup({
        sriCode: new FormControl('01', { nonNullable: true }),
        method: new FormControl('efectivo', { nonNullable: true }),
        amount: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.pattern(/^\d+([.,]\d{1,2})?$/)] }),
      }),
    );
  }

  protected removePayment(i: number): void {
    this.form.controls.payments.removeAt(i);
  }

  protected onMethod(p: PaymentForm, method: string): void {
    p.controls.sriCode.setValue(METHODS.find((m) => m.value === method)?.sriCode ?? '01');
  }

  /** Completa el valor pendiente en la forma de pago indicada. */
  protected fillRemaining(p: PaymentForm): void {
    const total = Number(this.preview().totals?.total ?? 0);
    const others = this.form.controls.payments.controls.filter((x) => x !== p).reduce((s, x) => s + (Number(x.controls.amount.value.replace(',', '.')) || 0), 0);
    p.controls.amount.setValue(Math.max(0, total - others).toFixed(2));
  }

  protected checkId(): void {
    const b = this.form.controls.buyer.controls;
    const id = b.id.value.trim();
    if (!id) return;
    if (id.length === 13) b.idType.setValue('04');
    else if (id.length === 10) b.idType.setValue('05');
    const t = b.idType.value;
    const r = t === '04' ? validateRuc(id) : t === '05' ? validateCedula(id) : { valid: true };
    b.id.setErrors(r.valid ? null : { identification: ('error' in r && r.error) || 'Identificación inválida' });
  }

  protected async submit(): Promise<void> {
    this.errorDetails.set([]);
    const v = this.form.getRawValue();
    const cfg = this.config();
    const totals = this.preview().totals;
    if (!cfg || !totals) return this.notify.error('Complete al menos un producto');
    if (v.customerKind === 'identified') {
      const b = this.form.controls.buyer.controls;
      if (!b.id.value || !b.name.value) {
        b.id.markAsTouched();
        b.name.markAsTouched();
        return this.notify.error('Ingrese la identificación y el nombre del cliente');
      }
    }
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return this.notify.error('Revise los campos marcados');
    }
    if (Math.abs(this.paid() - Number(totals.total)) > 0.001) return this.notify.error(`Las formas de pago deben sumar ${totals.total}`);

    const body: IssueInvoiceRequest = {
      emissionPointId: v.emissionPointId,
      buyer:
        v.customerKind === 'final'
          ? { idType: '07', id: cfg.finalConsumer.id, name: cfg.finalConsumer.name }
          : {
              idType: v.buyer.idType as '04',
              id: v.buyer.id.trim(),
              name: v.buyer.name.trim(),
              email: v.buyer.email || null,
              phone: v.buyer.phone || null,
              address: v.buyer.address || null,
            },
      lines: v.lines.map((l) => ({
        productId: l.productId,
        productUnitId: l.productUnitId,
        mainCode: l.mainCode || null,
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        discount: l.discount || '0',
        taxRateId: l.taxRateId,
      })),
      payments: v.payments.map((p) => ({ sriCode: p.sriCode, method: p.method, amount: p.amount })),
    };

    this.saving.set(true);
    try {
      const res = await this.api.issue(body);
      this.notify.ok(`Factura ${res.number} emitida y enviada al SRI`);
      await this.router.navigate(['/facturacion/comprobantes', res.documentId]);
    } catch (e) {
      this.notify.error(apiMessage(e));
      if (e instanceof HttpErrorResponse) this.errorDetails.set((e.error?.details as string[]) ?? []);
    } finally {
      this.saving.set(false);
    }
  }
}
