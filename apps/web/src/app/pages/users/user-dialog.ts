import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import type { EstablishmentItem, RoleItem, UserListItem } from '@vektra/shared-contracts';
import { firstValueFrom } from 'rxjs';
import { Notify } from '../../core/notify.service';
import { FieldError } from '../../shared/field-error';

export interface UserDialogData {
  user?: UserListItem;
  roles: RoleItem[];
  establishments: EstablishmentItem[];
}

@Component({
  selector: 'vk-user-dialog',
  imports: [ReactiveFormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, FieldError],
  template: `
    <h2 mat-dialog-title>{{ data.user ? 'Editar usuario' : 'Nuevo usuario' }}</h2>
    <mat-dialog-content>
      <form [formGroup]="form" class="vk-form-grid" id="user-form" (ngSubmit)="save()">
        <mat-form-field class="vk-full">
          <mat-label>Nombre completo</mat-label>
          <input matInput formControlName="fullName" />
          <mat-error><vk-field-error [control]="form.controls.fullName" /></mat-error>
        </mat-form-field>

        <mat-form-field class="vk-full">
          <mat-label>Correo electrónico</mat-label>
          <input matInput type="email" formControlName="email" />
          <mat-hint>Será su usuario para ingresar</mat-hint>
          <mat-error><vk-field-error [control]="form.controls.email" /></mat-error>
        </mat-form-field>

        @if (!data.user) {
          <mat-form-field class="vk-full">
            <mat-label>Contraseña inicial</mat-label>
            <input matInput type="text" formControlName="password" autocomplete="new-password" />
            <mat-hint>Mínimo 8 caracteres con letras y números. Si el correo ya existe en el sistema, se ignora.</mat-hint>
            <mat-error><vk-field-error [control]="form.controls.password" /></mat-error>
          </mat-form-field>
        }

        <mat-form-field>
          <mat-label>Roles</mat-label>
          <mat-select formControlName="roleIds" multiple>
            @for (r of data.roles; track r.id) {
              <mat-option [value]="r.id">{{ r.name }}</mat-option>
            }
          </mat-select>
          <mat-error><vk-field-error [control]="form.controls.roleIds" /></mat-error>
        </mat-form-field>

        <mat-form-field>
          <mat-label>Establecimiento</mat-label>
          <mat-select formControlName="defaultEstablishmentId">
            <mat-option [value]="null">Ninguno</mat-option>
            @for (e of data.establishments; track e.id) {
              <mat-option [value]="e.id">{{ e.code }} · {{ e.name }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
      </form>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancelar</button>
      <button matButton="filled" type="submit" form="user-form" [disabled]="saving()">Guardar</button>
    </mat-dialog-actions>
  `,
})
export class UserDialog {
  protected readonly data = inject<UserDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<UserDialog>);
  private readonly http = inject(HttpClient);
  private readonly notify = inject(Notify);
  protected readonly saving = signal(false);

  protected readonly form = new FormGroup({
    fullName: new FormControl(this.data.user?.fullName ?? '', { nonNullable: true, validators: [Validators.required, Validators.maxLength(200)] }),
    email: new FormControl(
      { value: this.data.user?.email ?? '', disabled: !!this.data.user },
      { nonNullable: true, validators: [Validators.required, Validators.email] },
    ),
    password: new FormControl('', { nonNullable: true, validators: [Validators.minLength(8)] }),
    roleIds: new FormControl<string[]>(this.data.user?.roles.map((r) => r.id) ?? [], { nonNullable: true, validators: [Validators.required] }),
    defaultEstablishmentId: new FormControl<string | null>(this.data.user?.defaultEstablishmentId ?? null),
  });

  protected async save(): Promise<void> {
    if (this.form.invalid) return this.form.markAllAsTouched();
    const v = this.form.getRawValue();
    this.saving.set(true);
    try {
      if (this.data.user) {
        await firstValueFrom(
          this.http.patch(`/api/users/${this.data.user.membershipId}`, {
            fullName: v.fullName,
            roleIds: v.roleIds,
            defaultEstablishmentId: v.defaultEstablishmentId,
          }),
        );
        this.notify.ok('Usuario actualizado');
      } else {
        const res = await firstValueFrom(
          this.http.post<{ existingUser: boolean }>('/api/users', {
            fullName: v.fullName,
            email: v.email,
            password: v.password || undefined,
            roleIds: v.roleIds,
            defaultEstablishmentId: v.defaultEstablishmentId,
          }),
        );
        this.notify.ok(res.existingUser ? 'El usuario ya existía: se le dio acceso a esta empresa' : 'Usuario creado');
      }
      this.ref.close(true);
    } catch (e) {
      this.notify.formError(e, this.form);
    } finally {
      this.saving.set(false);
    }
  }
}
