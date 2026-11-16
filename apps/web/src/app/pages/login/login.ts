import { Component, inject, input, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { Router } from '@angular/router';
import type { LoginResponse, TenantOption } from '@vektra/shared-contracts';
import { AuthService } from '../../core/auth.service';
import { apiMessage } from '../../core/http';
import { FieldError } from '../../shared/field-error';

type Step = 'credentials' | '2fa' | 'tenant';

@Component({
  selector: 'vk-login',
  imports: [ReactiveFormsModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatProgressBarModule, FieldError],
  templateUrl: './login.html',
  styleUrl: './login.scss',
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  /** ?expirada=1 desde el interceptor */
  readonly expirada = input<string>();

  protected readonly step = signal<Step>('credentials');
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly tenants = signal<TenantOption[]>([]);
  protected readonly showPassword = signal(false);
  private challenge = '';

  protected readonly credentials = new FormGroup({
    email: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.email] }),
    password: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
  });

  protected readonly code = new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.pattern(/^\d{6}$/)] });

  protected submitCredentials(): void {
    if (this.credentials.invalid) return this.credentials.markAllAsTouched();
    const { email, password } = this.credentials.getRawValue();
    void this.run(() => this.auth.login(email.trim(), password));
  }

  protected submitCode(): void {
    if (this.code.invalid) return this.code.markAsTouched();
    void this.run(() => this.auth.loginTwoFactor(this.challenge, this.code.value));
  }

  protected chooseTenant(t: TenantOption): void {
    void this.run(() => this.auth.selectTenant(this.challenge, t.id));
  }

  protected back(): void {
    this.step.set('credentials');
    this.error.set(null);
    this.code.reset();
  }

  private async run(action: () => Promise<LoginResponse>): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await action();
      if (res.step === 'done') {
        await this.router.navigateByUrl('/');
      } else {
        this.challenge = res.challenge;
        if (res.step === 'tenant') this.tenants.set(res.tenants);
        this.step.set(res.step);
      }
    } catch (e) {
      this.error.set(apiMessage(e));
      if (this.step() === '2fa') this.code.reset();
    } finally {
      this.loading.set(false);
    }
  }
}
