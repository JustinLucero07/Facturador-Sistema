import { inject, Injectable } from '@angular/core';
import { AbstractControl, FormGroup } from '@angular/forms';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { firstValueFrom } from 'rxjs';
import { ConfirmDialog, ConfirmData } from '../shared/confirm-dialog';
import { apiFields, apiMessage } from './http';

@Injectable({ providedIn: 'root' })
export class Notify {
  private readonly snack = inject(MatSnackBar);
  private readonly dialog = inject(MatDialog);

  ok(message: string): void {
    this.snack.open(message, 'Cerrar', { duration: 3500, panelClass: 'vk-snack-ok' });
  }

  error(errOrMessage: unknown): void {
    const message = typeof errOrMessage === 'string' ? errOrMessage : apiMessage(errOrMessage);
    this.snack.open(message, 'Cerrar', { duration: 6000, panelClass: 'vk-snack-error' });
  }

  /**
   * Muestra el error y marca en el formulario los campos que el servidor rechazó.
   * `map` traduce nombres de campo del API a controles del formulario cuando difieren.
   */
  formError(err: unknown, form: FormGroup, map: Record<string, string> = {}): void {
    const fields = apiFields(err);
    let placed = false;
    for (const [key, message] of Object.entries(fields)) {
      const control: AbstractControl | null = form.get(map[key] ?? key);
      if (control) {
        control.setErrors({ server: message });
        control.markAsTouched();
        placed = true;
      }
    }
    if (!placed || Object.keys(fields).length === 0) this.error(err);
  }

  confirm(data: ConfirmData): Promise<boolean> {
    return firstValueFrom(this.dialog.open(ConfirmDialog, { data, autoFocus: 'dialog' }).afterClosed()).then((r) => r === true);
  }
}
