import { Component, HostListener, input, model } from '@angular/core';

/** Teclado numérico táctil para cantidades y montos. */
@Component({
  selector: 'vk-keypad',
  template: `
    <div class="pad" role="group" aria-label="Teclado numérico">
      @for (k of keys; track k) {
        <button type="button" (click)="press(k)" [attr.aria-label]="k === '⌫' ? 'Borrar' : k">{{ k }}</button>
      }
    </div>
  `,
  styles: `
    .pad { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    button {
      min-height: 56px; border: 1px solid var(--mat-sys-outline-variant); border-radius: 12px;
      background: var(--mat-sys-surface-container-low); color: var(--mat-sys-on-surface);
      font: 600 22px/1 var(--mat-sys-body-large-font); cursor: pointer; touch-action: manipulation;
    }
    button:active { background: var(--mat-sys-primary-container); }
  `,
})
export class Keypad {
  readonly value = model('');
  readonly decimals = input(2);
  /** El valor actual es una sugerencia: la primera tecla lo reemplaza en vez de añadir. */
  readonly fresh = model(false);
  /** Capturar también el teclado físico (solo cuando no hay un campo de texto propio). */
  readonly keyboard = input(false);
  protected readonly keys = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '.', '0', '⌫'];

  @HostListener('document:keydown', ['$event'])
  protected onKey(ev: KeyboardEvent): void {
    if (!this.keyboard() || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const k = ev.key === 'Backspace' ? '⌫' : ev.key === ',' ? '.' : ev.key;
    if (!this.keys.includes(k)) return;
    ev.preventDefault();
    this.press(k);
  }

  protected press(k: string): void {
    let v = this.value();
    if (this.fresh()) {
      this.fresh.set(false);
      if (k !== '⌫') v = '';
    }
    if (k === '⌫') v = v.slice(0, -1);
    else if (k === '.') {
      if (this.decimals() > 0 && !v.includes('.')) v = (v || '0') + '.';
    } else {
      const [, dec] = v.split('.');
      if (dec !== undefined && dec.length >= this.decimals()) return;
      v = v === '0' ? k : v + k;
    }
    this.value.set(v);
  }
}
