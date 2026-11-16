import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import type { EmissionPointItem, EstablishmentItem, WarehouseItem } from '@vektra/shared-contracts';
import { firstValueFrom } from 'rxjs';
import { Notify } from '../../core/notify.service';
import { FieldError } from '../../shared/field-error';

export type StructureDialogData =
  | { kind: 'establishment'; item?: EstablishmentItem; suggestedCode?: string }
  | { kind: 'emissionPoint'; establishmentId: string; item?: EmissionPointItem; suggestedCode?: string }
  | { kind: 'warehouse'; establishmentId: string; item?: WarehouseItem };

const TITLES = {
  establishment: ['Nuevo establecimiento', 'Editar establecimiento'],
  emissionPoint: ['Nuevo punto de emisión', 'Editar punto de emisión'],
  warehouse: ['Nueva bodega', 'Editar bodega'],
} as const;

const CODE = [Validators.required, Validators.pattern(/^(?!000)\d{3}$/)];

@Component({
  selector: 'vk-structure-dialog',
  imports: [
    ReactiveFormsModule,
    MatDialogModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatFormFieldModule,
    MatInputModule,
    MatSlideToggleModule,
    FieldError,
  ],
  template: `
    <h2 mat-dialog-title>{{ title }}</h2>
    <mat-dialog-content>
      <form [formGroup]="form" class="vk-form-grid" id="structure-form" (ngSubmit)="save()">
        @if (data.kind !== 'warehouse') {
          <mat-form-field>
            <mat-label>Código SRI</mat-label>
            <input matInput formControlName="code" maxlength="3" inputmode="numeric" class="vk-mono" />
            <mat-hint>3 dígitos, ej. 001</mat-hint>
            <mat-error><vk-field-error [control]="form.controls.code" /></mat-error>
          </mat-form-field>
        }
        <mat-form-field [class.vk-full]="data.kind === 'warehouse'">
          <mat-label>Nombre</mat-label>
          <input matInput formControlName="name" />
          <mat-error><vk-field-error [control]="form.controls.name" /></mat-error>
        </mat-form-field>
        @if (data.kind === 'establishment') {
          <mat-form-field class="vk-full">
            <mat-label>Dirección del establecimiento</mat-label>
            <input matInput formControlName="address" />
            <mat-error><vk-field-error [control]="form.controls.address" /></mat-error>
          </mat-form-field>
        }
        @if (data.kind === 'emissionPoint') {
          <div class="vk-full kind">
            <span class="vk-muted">Tipo</span>
            <mat-button-toggle-group formControlName="kind" aria-label="Tipo de punto de emisión">
              <mat-button-toggle value="WEB">Web</mat-button-toggle>
              <mat-button-toggle value="DESKTOP">Caja de escritorio</mat-button-toggle>
            </mat-button-toggle-group>
            <p class="vk-muted hint">
              Una caja de escritorio puede facturar sin internet; por eso necesita su propio punto de emisión exclusivo.
            </p>
          </div>
        }
        <div class="vk-full toggles">
          <mat-slide-toggle formControlName="active">Activo</mat-slide-toggle>
          @if (data.kind === 'warehouse') {
            <mat-slide-toggle formControlName="isDefault">Bodega principal del establecimiento</mat-slide-toggle>
          }
        </div>
      </form>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancelar</button>
      <button matButton="filled" type="submit" form="structure-form" [disabled]="saving()">Guardar</button>
    </mat-dialog-actions>
  `,
  styles: `
    .kind { display: flex; flex-direction: column; gap: 8px; margin: 4px 0 12px; }
    .hint { margin: 0; font: var(--mat-sys-body-small); }
    .toggles { display: flex; flex-direction: column; gap: 12px; margin-top: 4px; }
  `,
})
export class StructureDialog {
  protected readonly data = inject<StructureDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<StructureDialog>);
  private readonly http = inject(HttpClient);
  private readonly notify = inject(Notify);
  protected readonly saving = signal(false);
  protected readonly title = TITLES[this.data.kind][this.data.item ? 1 : 0];

  private readonly item = this.data.item as Partial<EstablishmentItem & EmissionPointItem & WarehouseItem> | undefined;

  protected readonly form = new FormGroup({
    code: new FormControl(this.item?.code ?? ('suggestedCode' in this.data ? (this.data.suggestedCode ?? '') : ''), {
      nonNullable: true,
      validators: this.data.kind === 'warehouse' ? [] : CODE,
    }),
    name: new FormControl(this.item?.name ?? '', { nonNullable: true, validators: [Validators.required] }),
    address: new FormControl(this.item?.address ?? '', {
      nonNullable: true,
      validators: this.data.kind === 'establishment' ? [Validators.required] : [],
    }),
    kind: new FormControl<'WEB' | 'DESKTOP'>(this.item?.kind ?? 'WEB', { nonNullable: true }),
    active: new FormControl(this.item?.active ?? true, { nonNullable: true }),
    isDefault: new FormControl(this.item?.isDefault ?? false, { nonNullable: true }),
  });

  protected async save(): Promise<void> {
    if (this.form.invalid) return this.form.markAllAsTouched();
    const v = this.form.getRawValue();
    const d = this.data;
    let url: string;
    let body: object;
    if (d.kind === 'establishment') {
      url = '/api/establishments';
      body = { code: v.code, name: v.name, address: v.address, active: v.active };
    } else if (d.kind === 'emissionPoint') {
      url = '/api/emission-points';
      body = { establishmentId: d.establishmentId, code: v.code, name: v.name, kind: v.kind, active: v.active };
    } else {
      url = '/api/warehouses';
      body = { establishmentId: d.establishmentId, name: v.name, isDefault: v.isDefault, active: v.active };
    }
    this.saving.set(true);
    try {
      if (d.item) await firstValueFrom(this.http.patch(`${url}/${d.item.id}`, body));
      else await firstValueFrom(this.http.post(url, body));
      this.notify.ok('Guardado');
      this.ref.close(true);
    } catch (e) {
      this.notify.formError(e, this.form);
    } finally {
      this.saving.set(false);
    }
  }
}
