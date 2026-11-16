import { Component, input } from '@angular/core';
import { AbstractControl } from '@angular/forms';

/** Mensaje de error en español para un control de formulario (usar dentro de <mat-error>). */
@Component({
  selector: 'vk-field-error',
  template: `{{ message() }}`,
})
export class FieldError {
  readonly control = input.required<AbstractControl | null>();

  message(): string {
    const e = this.control()?.errors;
    if (!e) return '';
    if (e['server']) return e['server'];
    if (e['required']) return 'Este campo es obligatorio';
    if (e['email']) return 'Correo electrónico inválido';
    if (e['minlength']) return `Mínimo ${e['minlength'].requiredLength} caracteres`;
    if (e['maxlength']) return `Máximo ${e['maxlength'].requiredLength} caracteres`;
    if (e['pattern']) return 'Formato inválido';
    if (e['identification']) return e['identification'];
    return 'Valor inválido';
  }
}
