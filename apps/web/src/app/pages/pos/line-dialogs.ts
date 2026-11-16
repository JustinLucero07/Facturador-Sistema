import { CurrencyPipe, DatePipe } from '@angular/common';
import { Component, HostListener, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import type { QuoteView } from '@vektra/shared-contracts';
import { Notify } from '../../core/notify.service';
import { Keypad } from './keypad';
import { PosApi } from './pos.api';

export interface LineEdit {
  quantity: string;
  /** PVP con IVA */
  pvp: string;
  discount: string;
}

/** Editar una línea con el teclado táctil: cantidad, precio (PVP) y descuento. */
@Component({
  selector: 'vk-line-edit',
  imports: [MatDialogModule, MatButtonModule, Keypad],
  template: `
    <h2 mat-dialog-title>{{ data.name }}</h2>
    <mat-dialog-content class="c">
      <div class="vals">
        <button type="button" [class.on]="field() === 'quantity'" (click)="select('quantity')"><span>Cantidad</span><strong>{{ v.quantity || 0 }}</strong></button>
        <button type="button" [class.on]="field() === 'pvp'" [disabled]="!data.canDiscount" (click)="select('pvp')"><span>PVP</span><strong>\${{ v.pvp || 0 }}</strong></button>
        <button type="button" [class.on]="field() === 'discount'" [disabled]="!data.canDiscount" (click)="select('discount')"><span>Descuento</span><strong>\${{ v.discount || 0 }}</strong></button>
      </div>
      <vk-keypad [value]="current()" (valueChange)="set($event)" [keyboard]="true" [decimals]="field() === 'quantity' ? (data.allowsDecimal ? 3 : 0) : field() === 'pvp' ? 4 : 2" />
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancelar</button>
      <button matButton="filled" (click)="ok()">Aceptar</button>
    </mat-dialog-actions>
  `,
  styles: `
    .c { display: flex; flex-direction: column; gap: 12px; width: 340px; max-width: 100%; }
    .vals { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .vals button { font: inherit; color: inherit; background: none; text-align: left; border: 1px solid var(--mat-sys-outline-variant); border-radius: 10px; padding: 8px; display: flex; flex-direction: column; cursor: pointer; }
    .vals button:disabled { opacity: .5; cursor: default; } .vals button.on { border: 2px solid var(--mat-sys-primary); background: var(--mat-sys-primary-container); }
    .vals span { font: var(--mat-sys-label-small); color: var(--vk-muted); } .vals strong { font-weight: 600; font-size: 20px; line-height: 1.2; font-family: inherit; }
  `,
})
export class LineEditDialog {
  protected readonly data = inject<LineEdit & { name: string; canDiscount: boolean; allowsDecimal: boolean }>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<LineEditDialog, LineEdit>);
  protected readonly field = signal<keyof LineEdit>('quantity');
  protected v: LineEdit = { quantity: this.data.quantity, pvp: this.data.pvp, discount: this.data.discount === '0' ? '' : this.data.discount };
  /** Lo que se está tecleando: empieza vacío al elegir un campo (el valor anterior se mantiene si no se escribe nada). */
  protected readonly current = signal('');

  protected select(f: keyof LineEdit): void {
    this.field.set(f);
    this.current.set('');
  }

  protected set(value: string): void {
    this.v = { ...this.v, [this.field()]: value };
    this.current.set(value);
  }

  /** Teclado físico: Tab cambia de casilla, Enter acepta. */
  @HostListener('document:keydown', ['$event'])
  protected onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      this.ok();
    } else if (ev.key === 'Tab') {
      ev.preventDefault();
      const order: (keyof LineEdit)[] = this.data.canDiscount ? ['quantity', 'pvp', 'discount'] : ['quantity'];
      this.select(order[(order.indexOf(this.field()) + (ev.shiftKey ? order.length - 1 : 1)) % order.length]);
    }
  }

  protected ok(): void {
    if (!(Number(this.v.quantity) > 0)) return;
    this.ref.close({ quantity: this.v.quantity, pvp: this.v.pvp || '0', discount: this.v.discount || '0' });
  }
}

/** Buscar una proforma pendiente para facturarla. */
@Component({
  selector: 'vk-quotes-dialog',
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, CurrencyPipe, DatePipe],
  template: `
    <h2 mat-dialog-title>Proformas pendientes</h2>
    <mat-dialog-content>
      <mat-form-field class="w"><mat-label>Buscar cliente</mat-label><input matInput [(ngModel)]="search" (keyup.enter)="load()" /></mat-form-field>
      <ul>
        @for (q of quotes(); track q.id) {
          <li><button type="button" class="q" (click)="pick(q)" [class.expired]="q.expired">
            <span class="vk-mono">N.º {{ q.number }}</span>
            <span class="name">{{ q.buyerName }}</span>
            <span>{{ q.total | currency }}</span>
            <span class="vk-muted small">{{ q.expired ? 'vencida' : 'válida hasta ' + (q.validUntil | date: 'shortDate' : 'UTC') }}</span>
          </button></li>
        } @empty {
          <li class="vk-muted none">Sin proformas pendientes</li>
        }
      </ul>
    </mat-dialog-content>
    <mat-dialog-actions align="end"><button matButton mat-dialog-close>Cerrar</button></mat-dialog-actions>
  `,
  styles: `
    .w { width: 100%; } li { border-bottom: 1px solid var(--mat-sys-outline-variant); } .none { padding: 10px 8px; } ul { list-style: none; padding: 0; margin: 0; min-width: 480px; }
    .q { width: 100%; font: inherit; color: inherit; background: none; border: 0; text-align: left; display: grid; grid-template-columns: 130px 1fr 90px 130px; gap: 8px; padding: 10px 8px; cursor: pointer; align-items: center; }
    .q:hover { background: var(--mat-sys-surface-container-low); } .q.expired { opacity: .6; } .small { font: var(--mat-sys-body-small); }
    @media (max-width: 599px) { ul { min-width: 0; } .q { grid-template-columns: 1fr 1fr; } }
  `,
})
export class QuotesDialog implements OnInit {
  private readonly api = inject(PosApi);
  private readonly notify = inject(Notify);
  private readonly ref = inject(MatDialogRef<QuotesDialog, QuoteView>);
  protected readonly quotes = signal<QuoteView[]>([]);
  protected search = '';

  ngOnInit(): void {
    void this.load();
  }

  protected async load(): Promise<void> {
    try {
      this.quotes.set((await this.api.quotes(this.search.trim())).items);
    } catch (e) {
      this.notify.error(e);
    }
  }

  protected pick(q: QuoteView): void {
    this.ref.close(q);
  }
}
