import { Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { Router } from '@angular/router';
import { errorMessage, HubAuth } from '../hub';

@Component({
  selector: 'hub-login',
  imports: [ReactiveFormsModule, MatFormFieldModule, MatInputModule, MatButtonModule],
  template: `
    <main class="wrap">
      <form class="vk-card box" [formGroup]="form" (ngSubmit)="submit()">
        <div class="brand"><span class="mark">V</span> Vektra <strong>Hub</strong></div>
        <p class="vk-muted">Panel interno de Vektra Systems</p>
        <mat-form-field>
          <mat-label>Correo</mat-label>
          <input matInput type="email" formControlName="email" autocomplete="username" />
        </mat-form-field>
        <mat-form-field>
          <mat-label>Contraseña</mat-label>
          <input matInput type="password" formControlName="password" autocomplete="current-password" />
        </mat-form-field>
        @if (error()) {
          <p class="err" role="alert">{{ error() }}</p>
        }
        <button matButton="filled" type="submit" [disabled]="busy()">Ingresar</button>
      </form>
    </main>
  `,
  styles: `
    .wrap { min-height: 100vh; display: grid; place-items: center; padding: 16px; background: linear-gradient(160deg, #0b5560, #04262c); }
    .box { width: min(380px, 100%); display: flex; flex-direction: column; gap: 4px; padding: 28px; }
    .brand { display: flex; align-items: center; gap: 10px; font-size: 20px; }
    .mark { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; background: var(--mat-sys-primary); color: #fff; font-weight: 800; }
    .err { color: var(--vk-danger); margin: 0 0 8px; }
    button { height: 46px; margin-top: 8px; }
  `,
})
export class HubLogin {
  private readonly auth = inject(HubAuth);
  private readonly router = inject(Router);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly form = new FormGroup({
    email: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.email] }),
    password: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
  });

  protected async submit(): Promise<void> {
    if (this.form.invalid) return this.form.markAllAsTouched();
    this.busy.set(true);
    this.error.set(null);
    try {
      const { email, password } = this.form.getRawValue();
      await this.auth.login(email.trim(), password);
      await this.router.navigateByUrl('/');
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
