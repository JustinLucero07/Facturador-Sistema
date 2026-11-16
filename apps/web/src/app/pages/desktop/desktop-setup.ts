import { Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { apiMessage } from '../../core/http';
import { RuntimeService } from '../../core/runtime';

/** Primera vez en la caja de escritorio: vincularla con el servidor de la empresa. */
@Component({
  selector: 'vk-desktop-setup',
  imports: [ReactiveFormsModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatProgressBarModule],
  template: `
    <div class="page">
      <section class="card" aria-labelledby="t">
        <div class="brand"><span class="mark" aria-hidden="true">V</span> Vektra <strong>Caja</strong></div>
        @if (busy()) { <mat-progress-bar mode="indeterminate" class="bar" /> }
        <h1 id="t">Vincular esta caja</h1>
        <p class="vk-muted">
          En la web del sistema vaya a <strong>Administración → Cajas de escritorio</strong>, cree la caja y copie aquí la dirección y el código de 10 caracteres.
          La primera vez se descargan los productos, clientes y usuarios: necesita internet solo para este paso.
        </p>
        @if (error()) { <div class="err" role="alert">{{ error() }}</div> }
        <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
          <mat-form-field>
            <mat-label>Dirección del servidor</mat-label>
            <input matInput formControlName="serverUrl" placeholder="https://facturas.miempresa.com" autocomplete="url" inputmode="url" />
          </mat-form-field>
          <mat-form-field>
            <mat-label>Código de vinculación</mat-label>
            <input matInput formControlName="code" class="code" maxlength="12" autocomplete="off" autocapitalize="characters" />
            <mat-hint>Vence 30 minutos después de generarlo</mat-hint>
          </mat-form-field>
          <button matButton="filled" type="submit" class="go" [disabled]="busy()">{{ busy() ? 'Vinculando y descargando datos…' : 'Vincular caja' }}</button>
        </form>
        @if (rt.info().appVersion) { <p class="vk-muted small">Versión {{ rt.info().appVersion }}</p> }
      </section>
    </div>
  `,
  styles: `
    .page { min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--mat-sys-surface-container-low); }
    .card { width: min(460px, 100%); background: var(--mat-sys-surface); border-radius: 24px; padding: 32px; border: 1px solid var(--mat-sys-outline-variant); position: relative; overflow: hidden; }
    .bar { position: absolute; top: 0; left: 0; right: 0; }
    .brand { display: flex; align-items: center; gap: 8px; font-size: 17px; margin-bottom: 24px; }
    .mark { width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center; background: var(--mat-sys-primary); color: var(--mat-sys-on-primary); font-weight: 700; }
    h1 { font: var(--mat-sys-headline-small); margin: 0 0 8px; }
    form { display: flex; flex-direction: column; gap: 12px; margin-top: 20px; }
    .code { font-family: ui-monospace, monospace; letter-spacing: 0.2em; text-transform: uppercase; font-size: 20px; }
    .go { min-height: 48px; margin-top: 8px; }
    .err { margin-top: 16px; padding: 12px; border-radius: 12px; background: var(--mat-sys-error-container); color: var(--mat-sys-on-error-container); }
    .small { font: var(--mat-sys-body-small); margin: 16px 0 0; }
  `,
})
export class DesktopSetupPage {
  protected readonly rt = inject(RuntimeService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly form = new FormGroup({
    serverUrl: new FormControl(this.rt.info().serverUrl ?? '', { nonNullable: true, validators: [Validators.required] }),
    code: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
  });

  protected async submit(): Promise<void> {
    if (this.form.invalid) {
      this.error.set('Ingrese la dirección del servidor y el código');
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      const { serverUrl, code } = this.form.getRawValue();
      await this.rt.pair(serverUrl.trim(), code);
      await this.router.navigateByUrl(this.auth.isAuthenticated() ? '/pos' : '/ingresar');
    } catch (e) {
      this.error.set(apiMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
