import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, inject, OnInit, signal } from '@angular/core';
import { AbstractControl, FormControl, FormGroup, ReactiveFormsModule, ValidationErrors, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTableModule } from '@angular/material/table';
import type { TenantAdminItem } from '@vektra/shared-contracts';
import { BUSINESS_TEMPLATES, validateRuc } from '@vektra/shared-domain';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth.service';
import { Notify } from '../../core/notify.service';
import { FieldError } from '../../shared/field-error';

function rucValidator(c: AbstractControl): ValidationErrors | null {
  if (!c.value) return null;
  const r = validateRuc(String(c.value).trim());
  return r.valid && r.kind !== 'FINAL_CONSUMER' ? null : { identification: r.error ?? 'RUC inválido' };
}

/** Solo Soporte Vektra: empresas (RUC) de esta instalación. */
@Component({
  selector: 'vk-support-tenants',
  imports: [ReactiveFormsModule, MatTableModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, DatePipe, FieldError],
  templateUrl: './tenants.html',
  styles: `
    .grid { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(320px, 1fr); gap: 16px; align-items: start; }
    h2 { font: var(--mat-sys-title-medium); margin: 0 0 12px; }
    h3 { font: var(--mat-sys-title-small); margin: 12px 0 8px; }
    @media (max-width: 959px) { .grid { grid-template-columns: 1fr; } }
  `,
})
export class TenantsPage implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly notify = inject(Notify);
  private readonly auth = inject(AuthService);
  protected readonly tenants = signal<TenantAdminItem[]>([]);
  protected readonly saving = signal(false);
  protected readonly templates = BUSINESS_TEMPLATES;
  protected readonly columns = ['company', 'template', 'status', 'actions'];

  protected readonly form = new FormGroup({
    ruc: new FormControl('', { nonNullable: true, validators: [Validators.required, rucValidator] }),
    legalName: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    tradeName: new FormControl<string | null>(null),
    mainAddress: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    businessTemplate: new FormControl('general', { nonNullable: true }),
    admin: new FormGroup({
      fullName: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
      email: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.email] }),
      password: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.minLength(8)] }),
    }),
  });

  ngOnInit(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    this.tenants.set(await firstValueFrom(this.http.get<TenantAdminItem[]>('/api/admin/tenants')));
  }

  protected templateName(code: string): string {
    return BUSINESS_TEMPLATES.find((t) => t.code === code)?.name ?? code;
  }

  protected async create(): Promise<void> {
    if (this.form.invalid) return this.form.markAllAsTouched();
    this.saving.set(true);
    try {
      const res = await firstValueFrom(this.http.post<{ rucCheckDigitWarning: boolean }>('/api/admin/tenants', this.form.getRawValue()));
      this.notify.ok(
        res.rucCheckDigitWarning
          ? 'Empresa creada. Aviso: el RUC no cumple el dígito verificador; confírmelo en el SRI.'
          : 'Empresa creada con su establecimiento 001, punto de emisión 001 y bodega principal',
      );
      this.form.reset({ businessTemplate: 'general' });
      await Promise.all([this.load(), this.auth.reloadSession()]);
    } catch (e) {
      this.notify.formError(e, this.form, { 'admin.email': 'admin.email', 'admin.password': 'admin.password', 'admin.fullName': 'admin.fullName' });
    } finally {
      this.saving.set(false);
    }
  }

  protected async setStatus(t: TenantAdminItem, suspend: boolean): Promise<void> {
    if (suspend) {
      const ok = await this.notify.confirm({
        title: 'Suspender empresa',
        message: `Los usuarios de ${t.tradeName ?? t.legalName} no podrán ingresar.`,
        confirmLabel: 'Suspender',
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await firstValueFrom(this.http.post(`/api/admin/tenants/${t.id}/${suspend ? 'suspend' : 'activate'}`, {}));
      await this.load();
    } catch (e) {
      this.notify.error(e);
    }
  }
}
