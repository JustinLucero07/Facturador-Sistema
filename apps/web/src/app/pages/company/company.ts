import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, inject, OnInit, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { type CompanyInfo, TAX_REGIMES } from '@vektra/shared-contracts';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth.service';
import { LicenseStore } from '../../core/license.store';
import { Notify } from '../../core/notify.service';
import { FieldError } from '../../shared/field-error';

@Component({
  selector: 'vk-company',
  imports: [
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatTooltipModule,
    DatePipe,
    FieldError,
  ],
  templateUrl: './company.html',
  styleUrl: './company.scss',
})
export class CompanyPage implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly notify = inject(Notify);
  protected readonly auth = inject(AuthService);
  protected readonly license = inject(LicenseStore);

  protected readonly company = signal<CompanyInfo | null>(null);
  protected readonly saving = signal(false);
  protected readonly regimes = Object.entries(TAX_REGIMES).map(([value, label]) => ({ value, label }));
  protected readonly activationCode = new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.minLength(20)] });

  protected readonly form = new FormGroup({
    legalName: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    tradeName: new FormControl<string | null>(null),
    mainAddress: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    taxRegime: new FormControl<'GENERAL' | 'RIMPE_EMPRENDEDOR' | 'RIMPE_NEGOCIO_POPULAR'>('GENERAL', { nonNullable: true }),
    keepsAccounting: new FormControl(false, { nonNullable: true }),
    specialTaxpayerNumber: new FormControl<string | null>(null),
    withholdingAgentNumber: new FormControl<string | null>(null),
    environment: new FormControl<1 | 2>(1, { nonNullable: true }),
    allowNegativeStock: new FormControl(true, { nonNullable: true }),
    quantityDecimals: new FormControl(2, { nonNullable: true, validators: [Validators.min(0), Validators.max(4)] }),
  });

  async ngOnInit(): Promise<void> {
    await this.load();
    if (!this.auth.can('company.update')) this.form.disable();
    void this.license.load();
  }

  private async load(): Promise<void> {
    const c = await firstValueFrom(this.http.get<CompanyInfo>('/api/company'));
    this.company.set(c);
    this.form.reset({
      legalName: c.legalName,
      tradeName: c.tradeName,
      mainAddress: c.mainAddress,
      taxRegime: c.taxRegime,
      keepsAccounting: c.keepsAccounting,
      specialTaxpayerNumber: c.specialTaxpayerNumber,
      withholdingAgentNumber: c.withholdingAgentNumber,
      environment: c.environment === 2 ? 2 : 1,
      allowNegativeStock: c.settings.allowNegativeStock ?? true,
      quantityDecimals: c.settings.quantityDecimals ?? 2,
    });
  }

  protected async save(): Promise<void> {
    if (this.form.invalid) return this.form.markAllAsTouched();
    const v = this.form.getRawValue();
    const current = this.company();
    if (current && current.environment !== 2 && v.environment === 2) {
      const ok = await this.notify.confirm({
        title: 'Pasar a producción',
        message: 'Desde ahora los comprobantes se enviarán al SRI con validez tributaria. Confirme que su firma electrónica y datos son correctos.',
        confirmLabel: 'Pasar a producción',
      });
      if (!ok) return;
    }
    this.saving.set(true);
    try {
      const { allowNegativeStock, quantityDecimals, ...rest } = v;
      await firstValueFrom(this.http.patch('/api/company', { ...rest, settings: { allowNegativeStock, quantityDecimals } }));
      this.notify.ok('Datos de la empresa guardados');
      await Promise.all([this.load(), this.auth.reloadSession()]);
    } catch (e) {
      this.notify.formError(e, this.form);
    } finally {
      this.saving.set(false);
    }
  }

  protected async toggleModule(code: string, enabled: boolean): Promise<void> {
    try {
      await firstValueFrom(this.http.patch(`/api/company/modules/${code}`, { enabled }));
      this.notify.ok(enabled ? 'Módulo activado' : 'Módulo desactivado');
      await Promise.all([this.load(), this.auth.reloadSession()]);
    } catch (e) {
      this.notify.error(e);
      await this.load();
    }
  }

  protected async activate(): Promise<void> {
    if (this.activationCode.invalid) return this.activationCode.markAsTouched();
    try {
      await firstValueFrom(this.http.post('/api/license/activate', { code: this.activationCode.value.trim() }));
      this.activationCode.reset();
      this.notify.ok('Licencia activada');
      await this.license.load();
    } catch (e) {
      this.notify.error(e);
    }
  }
}
