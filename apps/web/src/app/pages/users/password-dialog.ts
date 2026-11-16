import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import type { UserListItem } from '@vektra/shared-contracts';
import { firstValueFrom } from 'rxjs';
import { Notify } from '../../core/notify.service';
import { FieldError } from '../../shared/field-error';

@Component({
  selector: 'vk-password-dialog',
  imports: [ReactiveFormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, FieldError],
  template: `
    <h2 mat-dialog-title>Cambiar contraseña</h2>
    <mat-dialog-content>
      <p class="vk-muted">
        Nueva contraseña para <strong>{{ user.fullName }}</strong>. Se cerrarán sus sesiones abiertas y se desbloqueará la cuenta.
      </p>
      <form [formGroup]="form" id="pwd-form" (ngSubmit)="save()">
        <mat-form-field style="width: 100%">
          <mat-label>Nueva contraseña</mat-label>
          <input matInput type="text" formControlName="newPassword" autocomplete="new-password" />
          <mat-error><vk-field-error [control]="form.controls.newPassword" /></mat-error>
        </mat-form-field>
      </form>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancelar</button>
      <button matButton="filled" type="submit" form="pwd-form" [disabled]="saving()">Guardar</button>
    </mat-dialog-actions>
  `,
})
export class PasswordDialog {
  protected readonly user = inject<UserListItem>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<PasswordDialog>);
  private readonly http = inject(HttpClient);
  private readonly notify = inject(Notify);
  protected readonly saving = signal(false);
  protected readonly form = new FormGroup({
    newPassword: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.minLength(8)] }),
  });

  protected async save(): Promise<void> {
    if (this.form.invalid) return this.form.markAllAsTouched();
    this.saving.set(true);
    try {
      await firstValueFrom(this.http.post(`/api/users/${this.user.membershipId}/reset-password`, this.form.getRawValue()));
      this.notify.ok('Contraseña actualizada');
      this.ref.close(true);
    } catch (e) {
      this.notify.formError(e, this.form);
    } finally {
      this.saving.set(false);
    }
  }
}
