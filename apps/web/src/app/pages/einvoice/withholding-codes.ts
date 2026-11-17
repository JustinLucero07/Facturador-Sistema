import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import type { WithholdingCodeItem, WithholdingCodeRequest } from '@vektra/shared-contracts';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth.service';
import { apiMessage } from '../../core/http';
import { Notify } from '../../core/notify.service';

@Component({
  selector: 'vk-withholding-code-dialog',
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatCheckboxModule],
  template: `
    <h2 mat-dialog-title>{{ data.item ? 'Editar código ' + data.item.code : 'Nuevo código de retención' }}</h2>
    <mat-dialog-content class="f">
      <mat-form-field>
        <mat-label>Impuesto</mat-label>
        <select matNativeControl [(ngModel)]="v.tax" [disabled]="!!data.item">
          <option value="1">Renta</option>
          <option value="2">IVA</option>
        </select>
      </mat-form-field>
      <mat-form-field>
        <mat-label>Código</mat-label>
        <input matInput [(ngModel)]="v.code" [readonly]="!!data.item" maxlength="10" />
      </mat-form-field>
      <mat-form-field class="span">
        <mat-label>Concepto</mat-label>
        <textarea matInput [(ngModel)]="v.description" rows="2" maxlength="500"></textarea>
      </mat-form-field>
      <mat-form-field>
        <mat-label>Porcentaje (vacío = variable)</mat-label>
        <input matInput [(ngModel)]="v.percentage" inputmode="decimal" />
      </mat-form-field>
      <mat-form-field>
        <mat-label>Nota del porcentaje</mat-label>
        <input matInput [(ngModel)]="v.percentageNote" maxlength="300" />
      </mat-form-field>
      <mat-form-field>
        <mat-label>Vigente desde</mat-label>
        <input matInput type="date" [(ngModel)]="v.validFrom" />
      </mat-form-field>
      <mat-form-field>
        <mat-label>Vigente hasta</mat-label>
        <input matInput type="date" [(ngModel)]="v.validTo" />
      </mat-form-field>
      <mat-checkbox [(ngModel)]="v.active">Activo</mat-checkbox>
      <p class="vk-muted span small">Fuente oficial: Catálogo ATS (renta, Tabla 3.10) y Ficha Técnica, Tabla 20 (IVA). Cambie un porcentaje solo cuando lo disponga una resolución del SRI.</p>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancelar</button>
      <button matButton="filled" (click)="save()" [disabled]="busy()">Guardar</button>
    </mat-dialog-actions>
  `,
  styles: `
    .f { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; width: min(560px, 84vw); }
    .span { grid-column: 1 / -1; }
    .small { font: var(--mat-sys-body-small); }
  `,
})
export class WithholdingCodeDialog {
  protected readonly data = inject<{ item: WithholdingCodeItem | null }>(MAT_DIALOG_DATA);
  private readonly http = inject(HttpClient);
  private readonly notify = inject(Notify);
  private readonly ref = inject(MatDialogRef<WithholdingCodeDialog, boolean>);
  protected readonly busy = signal(false);
  protected v = {
    tax: (this.data.item?.tax ?? '1') as '1' | '2',
    code: this.data.item?.code ?? '',
    description: this.data.item?.description ?? '',
    percentage: this.data.item?.percentage ?? '',
    percentageNote: this.data.item?.percentageNote ?? '',
    validFrom: this.data.item?.validFrom ?? '',
    validTo: this.data.item?.validTo ?? '',
    active: this.data.item?.active ?? true,
  };

  protected async save(): Promise<void> {
    const body: WithholdingCodeRequest = {
      tax: this.v.tax,
      code: this.v.code.trim(),
      description: this.v.description.trim(),
      percentage: this.v.percentage === '' ? null : String(this.v.percentage),
      percentageNote: this.v.percentageNote.trim() || null,
      validFrom: this.v.validFrom || null,
      validTo: this.v.validTo || null,
      active: this.v.active,
    };
    this.busy.set(true);
    try {
      if (this.data.item) await firstValueFrom(this.http.patch(`/api/tax/withholding-codes/${this.data.item.id}`, body));
      else await firstValueFrom(this.http.post('/api/tax/withholding-codes', body));
      this.ref.close(true);
    } catch (e) {
      this.notify.error(apiMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}

/** Catálogo de códigos de retención (renta del Catálogo ATS, IVA de la Tabla 20 de la Ficha). */
@Component({
  selector: 'vk-withholding-codes',
  imports: [FormsModule, MatButtonModule, MatButtonToggleModule, MatFormFieldModule, MatInputModule],
  template: `
    <div class="vk-page">
      <div class="vk-page-header">
        <div>
          <h1>Códigos de retención</h1>
          <p>Conceptos y porcentajes oficiales del SRI (Catálogo ATS y Ficha Técnica). Se usan al emitir comprobantes de retención a proveedores.</p>
        </div>
        @if (canEdit) { <button matButton="filled" (click)="edit(null)"><span class="material-symbols-outlined">add</span> Nuevo código</button> }
      </div>
      <div class="filters">
        <mat-button-toggle-group [(ngModel)]="tax" (ngModelChange)="refresh()" aria-label="Impuesto">
          <mat-button-toggle value="1">Renta</mat-button-toggle>
          <mat-button-toggle value="2">IVA</mat-button-toggle>
        </mat-button-toggle-group>
        <mat-form-field class="search">
          <mat-label>Buscar código o concepto</mat-label>
          <input matInput [(ngModel)]="q" (ngModelChange)="refresh()" />
        </mat-form-field>
        <label class="inactive"><input type="checkbox" [(ngModel)]="showInactive" (ngModelChange)="refresh()" /> Ver inactivos (pagos al exterior)</label>
      </div>
      <div class="vk-table-wrap">
        <table class="simple">
          <thead><tr><th>Código</th><th>Concepto</th><th class="r">%</th><th>Vigencia</th><th></th></tr></thead>
          <tbody>
            @for (c of rows(); track c.id) {
              <tr [class.off]="!c.active">
                <td class="vk-mono">{{ c.code }}</td>
                <td>{{ c.description }}</td>
                <td class="r">
                  @if (c.percentage !== null) { {{ +c.percentage }}% } @else { <span class="vk-muted" [title]="c.percentageNote ?? ''">variable</span> }
                </td>
                <td class="vk-muted small">{{ c.validFrom ? 'desde ' + c.validFrom : '' }}{{ c.validTo ? ' hasta ' + c.validTo : '' }}</td>
                <td class="r">@if (canEdit) { <button matIconButton (click)="edit(c)" [attr.aria-label]="'Editar ' + c.code"><span class="material-symbols-outlined">edit</span></button> }</td>
              </tr>
            } @empty {
              <tr><td colspan="5" class="vk-muted">Sin resultados</td></tr>
            }
          </tbody>
        </table>
      </div>
    </div>
  `,
  styles: `
    .filters { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
    .search { width: min(360px, 100%); }
    .inactive { font: var(--mat-sys-body-small); display: flex; gap: 6px; align-items: center; }
    table.simple { width: 100%; border-collapse: collapse; }
    table.simple th, table.simple td { padding: 8px 12px; border-bottom: 1px solid var(--mat-sys-outline-variant); text-align: left; vertical-align: top; }
    table.simple th { font: var(--mat-sys-label-medium); color: var(--vk-muted); }
    .r { text-align: right !important; white-space: nowrap; }
    .small { font: var(--mat-sys-body-small); white-space: nowrap; }
    tr.off { opacity: 0.5; }
  `,
})
export class WithholdingCodesPage implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(Notify);
  protected readonly canEdit = inject(AuthService).can('tax.manage');
  private readonly all = signal<WithholdingCodeItem[]>([]);
  private readonly version = signal(0);
  protected tax: '1' | '2' = '1';
  protected q = '';
  protected showInactive = false;

  protected readonly rows = computed(() => {
    this.version();
    const q = this.q.trim().toLowerCase();
    return this.all().filter(
      (c) => c.tax === this.tax && (this.showInactive || c.active) && (!q || c.code.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)),
    );
  });

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  private async load(): Promise<void> {
    try {
      this.all.set(await firstValueFrom(this.http.get<WithholdingCodeItem[]>('/api/tax/withholding-codes')));
    } catch (e) {
      this.notify.error(e);
    }
  }

  protected refresh(): void {
    this.version.update((v) => v + 1);
  }

  protected async edit(item: WithholdingCodeItem | null): Promise<void> {
    const ok = await firstValueFrom(this.dialog.open(WithholdingCodeDialog, { data: { item }, maxWidth: '96vw' }).afterClosed());
    if (ok) {
      this.notify.ok('Código guardado');
      await this.load();
    }
  }
}
