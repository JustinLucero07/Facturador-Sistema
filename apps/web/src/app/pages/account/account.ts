import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import type { TwoFactorSetupResponse } from '@vektra/shared-contracts';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth.service';
import { Notify } from '../../core/notify.service';
import { FieldError } from '../../shared/field-error';

const CODE = [Validators.required, Validators.pattern(/^\d{6}$/)];

@Component({
  selector: 'vk-account',
  imports: [ReactiveFormsModule, MatFormFieldModule, MatInputModule, MatButtonModule, FieldError],
  templateUrl: './account.html',
  styles: `
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; align-items: start; }
    h2 { font: var(--mat-sys-title-medium); margin: 0 0 4px; }
    .sub { margin: 0 0 16px; }
    form { display: flex; flex-direction: column; }
    .qr { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; margin: 8px 0 16px; }
    .qr img { width: 168px; height: 168px; border-radius: 8px; border: 1px solid var(--mat-sys-outline-variant); }
    .secret { word-break: break-all; }
    .status { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
  `,
})
export class AccountPage {
  private readonly http = inject(HttpClient);
  private readonly notify = inject(Notify);
  protected readonly auth = inject(AuthService);
  protected readonly setup = signal<TwoFactorSetupResponse | null>(null);
  protected readonly busy = signal(false);

  protected readonly password = new FormGroup({
    currentPassword: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    newPassword: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.minLength(8)] }),
  });
  protected readonly enableCode = new FormControl('', { nonNullable: true, validators: CODE });
  protected readonly disable = new FormGroup({
    password: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    code: new FormControl('', { nonNullable: true, validators: CODE }),
  });

  protected async changePassword(): Promise<void> {
    if (this.password.invalid) return this.password.markAllAsTouched();
    this.busy.set(true);
    try {
      await firstValueFrom(this.http.post('/api/auth/change-password', this.password.getRawValue()));
      this.notify.ok('Contraseña cambiada. Ingrese nuevamente con su nueva contraseña.');
      await this.auth.logout();
    } catch (e) {
      this.notify.formError(e, this.password);
    } finally {
      this.busy.set(false);
    }
  }

  protected async startSetup(): Promise<void> {
    try {
      this.setup.set(await firstValueFrom(this.http.post<TwoFactorSetupResponse>('/api/auth/2fa/setup', {})));
    } catch (e) {
      this.notify.error(e);
    }
  }

  protected async enable(): Promise<void> {
    if (this.enableCode.invalid) return this.enableCode.markAsTouched();
    try {
      await firstValueFrom(this.http.post('/api/auth/2fa/enable', { code: this.enableCode.value }));
      this.setup.set(null);
      this.enableCode.reset();
      await this.auth.reloadSession();
      this.notify.ok('Verificación en dos pasos activada');
    } catch (e) {
      this.notify.error(e);
    }
  }

  protected async disableTwoFactor(): Promise<void> {
    if (this.disable.invalid) return this.disable.markAllAsTouched();
    try {
      await firstValueFrom(this.http.post('/api/auth/2fa/disable', this.disable.getRawValue()));
      this.disable.reset();
      await this.auth.reloadSession();
      this.notify.ok('Verificación en dos pasos desactivada');
    } catch (e) {
      this.notify.error(e);
    }
  }
}
