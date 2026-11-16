import { DatePipe } from '@angular/common';
import { Component, inject, OnInit, signal } from '@angular/core';
import { FormControl, FormGroup, FormGroupDirective, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import type { CertificateStatus } from '@vektra/shared-contracts';
import { AuthService } from '../../core/auth.service';
import { Notify } from '../../core/notify.service';
import { FieldError } from '../../shared/field-error';
import { EInvoiceApi } from './einvoice.api';

@Component({
  selector: 'vk-einvoice-settings',
  imports: [ReactiveFormsModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatSlideToggleModule, DatePipe, FieldError],
  template: `
    <div class="vk-page">
      <div class="vk-page-header">
        <div>
          <h1>Firma electrónica y correo</h1>
          <p>La firma (.p12) se guarda cifrada en el servidor y nunca se envía al navegador.</p>
        </div>
      </div>

      <div class="grid">
        <section class="vk-card">
          <h2>Firma electrónica</h2>
          @if (cert(); as c) {
            <div class="cert" [class]="'cert ' + c.level">
              <span class="material-symbols-outlined">{{ c.level === 'ok' ? 'verified_user' : c.level === 'missing' ? 'key_off' : 'warning' }}</span>
              <div>
                <strong>{{ c.message }}</strong>
                @if (c.present) {
                  <dl class="kv">
                    <dt>Titular</dt><dd>{{ c.holderName }}</dd>
                    <dt>Emisor</dt><dd class="small">{{ unescape(c.issuer) }}</dd>
                    <dt>Vigencia</dt><dd>{{ c.validFrom | date: 'mediumDate' }} – {{ c.validTo | date: 'mediumDate' }}</dd>
                    <dt>Días restantes</dt><dd>{{ c.daysLeft }}</dd>
                  </dl>
                }
              </div>
            </div>
          }
          @if (auth.can('einvoice.certificate')) {
            <form [formGroup]="certForm" (ngSubmit)="upload(certNgForm)" #certNgForm="ngForm" class="upload">
              <h3>{{ cert()?.present ? 'Reemplazar firma' : 'Cargar firma' }}</h3>
              <label class="file">
                <input type="file" accept=".p12,.pfx,application/x-pkcs12" (change)="pick($event)" />
                <span class="material-symbols-outlined">upload_file</span>
                {{ file()?.name ?? 'Seleccionar archivo .p12' }}
              </label>
              <mat-form-field class="w">
                <mat-label>Contraseña de la firma</mat-label>
                <input matInput type="password" formControlName="password" autocomplete="off" />
                <mat-error><vk-field-error [control]="certForm.controls.password" /></mat-error>
              </mat-form-field>
              <div class="vk-actions"><button matButton="filled" type="submit" [disabled]="busy()">Guardar firma</button></div>
            </form>
          }
        </section>

        <section class="vk-card">
          <h2>Correo de salida (SMTP)</h2>
          <p class="vk-muted">Las facturas se envían a sus clientes desde el correo de su empresa.</p>
          <form [formGroup]="mail" (ngSubmit)="saveMail()" class="vk-form-grid">
            <mat-form-field class="vk-full"><mat-label>Servidor SMTP</mat-label><input matInput formControlName="host" placeholder="smtp.gmail.com" /><mat-error><vk-field-error [control]="mail.controls.host" /></mat-error></mat-form-field>
            <mat-form-field><mat-label>Puerto</mat-label><input matInput type="number" formControlName="port" /></mat-form-field>
            <div class="toggle"><mat-slide-toggle formControlName="secure">SSL/TLS directo (puerto 465)</mat-slide-toggle></div>
            <mat-form-field><mat-label>Usuario</mat-label><input matInput formControlName="username" autocomplete="off" /></mat-form-field>
            <mat-form-field>
              <mat-label>Contraseña</mat-label>
              <input matInput type="password" formControlName="password" autocomplete="new-password" [placeholder]="hasPassword() ? '•••••• (guardada)' : ''" />
              <mat-hint>{{ hasPassword() ? 'Déjela vacía para mantener la actual' : 'Gmail: use una contraseña de aplicación' }}</mat-hint>
            </mat-form-field>
            <mat-form-field><mat-label>Nombre del remitente</mat-label><input matInput formControlName="fromName" /><mat-error><vk-field-error [control]="mail.controls.fromName" /></mat-error></mat-form-field>
            <mat-form-field><mat-label>Correo del remitente</mat-label><input matInput type="email" formControlName="fromEmail" /><mat-error><vk-field-error [control]="mail.controls.fromEmail" /></mat-error></mat-form-field>
            <mat-form-field class="vk-full"><mat-label>Responder a (opcional)</mat-label><input matInput type="email" formControlName="replyTo" /></mat-form-field>
            <div class="toggle vk-full"><mat-slide-toggle formControlName="enabled">Enviar facturas por correo automáticamente</mat-slide-toggle></div>
            @if (auth.can('company.update')) {
              <div class="vk-actions vk-full">
                <button matButton type="button" (click)="test()">Enviar correo de prueba</button>
                <button matButton="filled" type="submit">Guardar</button>
              </div>
            }
          </form>
        </section>
      </div>
    </div>
  `,
  styles: `
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px; align-items: start; }
    h2 { font: var(--mat-sys-title-medium); margin: 0 0 12px; }
    h3 { font: var(--mat-sys-title-small); margin: 16px 0 8px; }
    .cert { display: flex; gap: 12px; padding: 12px; border-radius: 10px; background: var(--mat-sys-surface-container-low); }
    .cert.ok .material-symbols-outlined { color: var(--vk-success); }
    .cert.warn { background: var(--vk-warn-bg); color: var(--vk-warn); }
    .cert.danger, .cert.missing { background: var(--vk-danger-bg); color: var(--vk-danger); }
    .kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 8px 0 0; color: var(--mat-sys-on-surface); }
    .kv dt { color: var(--vk-muted); } .kv dd { margin: 0; word-break: break-word; }
    .small { font: var(--mat-sys-body-small); }
    .file { display: flex; align-items: center; gap: 8px; padding: 14px; border: 1px dashed var(--mat-sys-outline); border-radius: 10px; cursor: pointer; margin-bottom: 12px; }
    .file input { display: none; }
    .w { width: 100%; }
    .toggle { display: flex; align-items: center; min-height: 56px; }
  `,
})
export class EInvoiceSettingsPage implements OnInit {
  private readonly api = inject(EInvoiceApi);
  private readonly notify = inject(Notify);
  protected readonly auth = inject(AuthService);
  protected readonly cert = signal<CertificateStatus | null>(null);
  protected readonly file = signal<File | null>(null);
  protected readonly busy = signal(false);
  protected readonly hasPassword = signal(false);

  protected readonly certForm = new FormGroup({ password: new FormControl('', { nonNullable: true, validators: [Validators.required] }) });
  protected readonly mail = new FormGroup({
    host: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    port: new FormControl(587, { nonNullable: true, validators: [Validators.required] }),
    secure: new FormControl(false, { nonNullable: true }),
    username: new FormControl('', { nonNullable: true }),
    password: new FormControl('', { nonNullable: true }),
    fromName: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    fromEmail: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.email] }),
    replyTo: new FormControl('', { nonNullable: true, validators: [Validators.email] }),
    enabled: new FormControl(true, { nonNullable: true }),
  });

  async ngOnInit(): Promise<void> {
    try {
      this.cert.set(await this.api.certificate());
      const m = await this.api.mailConfig();
      if (m) {
        this.mail.patchValue({ ...m, username: m.username ?? '', replyTo: m.replyTo ?? '', password: '' });
        this.hasPassword.set(m.hasPassword);
      }
      if (!this.auth.can('company.update')) this.mail.disable();
    } catch (e) {
      this.notify.error(e);
    }
  }

  protected pick(ev: Event): void {
    this.file.set((ev.target as HTMLInputElement).files?.[0] ?? null);
  }

  /** Nombre RFC 2253 sin escapes (\, → ,) para mostrarlo. */
  protected unescape(s: string | null): string {
    return (s ?? '').replace(/\\(.)/g, '$1');
  }

  protected async upload(formDir: FormGroupDirective): Promise<void> {
    const f = this.file();
    if (!f) return this.notify.error('Seleccione el archivo .p12');
    if (this.certForm.invalid) return this.certForm.markAllAsTouched();
    this.busy.set(true);
    try {
      this.cert.set(await this.api.uploadCertificate(f, this.certForm.controls.password.value));
      formDir.resetForm();
      this.file.set(null);
      this.notify.ok('Firma electrónica guardada');
    } catch (e) {
      this.notify.formError(e, this.certForm);
    } finally {
      this.busy.set(false);
    }
  }

  protected async saveMail(): Promise<void> {
    if (this.mail.invalid) return this.mail.markAllAsTouched();
    const v = this.mail.getRawValue();
    try {
      await this.api.saveMailConfig({ ...v, username: v.username || null, password: v.password || null, replyTo: v.replyTo || null });
      this.hasPassword.set(this.hasPassword() || !!v.password);
      this.mail.controls.password.reset();
      this.notify.ok('Configuración de correo guardada');
    } catch (e) {
      this.notify.formError(e, this.mail);
    }
  }

  protected async test(): Promise<void> {
    const to = window.prompt('¿A qué correo enviamos la prueba?', this.mail.controls.fromEmail.value);
    if (!to) return;
    try {
      await this.api.testMail(to.trim());
      this.notify.ok(`Correo de prueba enviado a ${to}`);
    } catch (e) {
      this.notify.error(e);
    }
  }
}
