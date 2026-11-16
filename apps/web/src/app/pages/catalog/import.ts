import { DatePipe, KeyValuePipe } from '@angular/common';
import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { IMPORT_KINDS, type ImportKind, type ImportPreview, type ImportResult } from '@vektra/shared-contracts';
import { AuthService } from '../../core/auth.service';
import { Notify } from '../../core/notify.service';
import { openBlob } from '../einvoice/einvoice.api';
import { CatalogApi } from './catalog.api';

const PERMS: Record<ImportKind, string> = { products: 'catalog.manage', parties: 'customers.manage', initial_stock: 'inventory.adjust' };

@Component({
  selector: 'vk-import',
  imports: [FormsModule, MatButtonModule, MatButtonToggleModule, MatProgressBarModule, DatePipe, KeyValuePipe],
  template: `
    <div class="vk-page">
      <div class="vk-page-header">
        <div>
          <h1>Importar desde Excel</h1>
          <p>1. Descargue la plantilla · 2. Llénela · 3. Revise la vista previa · 4. Confirme. Nada se guarda hasta confirmar.</p>
        </div>
      </div>

      <section class="vk-card steps">
        <mat-button-toggle-group [(ngModel)]="kind" (change)="reset()" aria-label="Qué importar">
          @for (k of kinds; track k.key) {
            @if (auth.can(perms[k.key])) { <mat-button-toggle [value]="k.key">{{ k.value }}</mat-button-toggle> }
          }
        </mat-button-toggle-group>
        <div class="row">
          <button matButton="outlined" (click)="template()"><span class="material-symbols-outlined">download</span> Descargar plantilla</button>
          <label class="file" [class.busy]="busy()">
            <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" (change)="upload($event)" [disabled]="busy()" />
            <span class="material-symbols-outlined">upload_file</span> {{ fileName() ?? 'Subir archivo Excel (.xlsx)' }}
          </label>
        </div>
        @if (kind === 'initial_stock') { <p class="vk-muted small">Importe primero los productos. Los saldos iniciales se registran en el kárdex con su costo y definen el costo promedio.</p> }
        @if (busy()) { <mat-progress-bar mode="indeterminate" /> }
      </section>

      @if (preview(); as p) {
        <section class="vk-card">
          <div class="summary">
            <div><div class="big">{{ p.total }}</div><div class="vk-muted">filas</div></div>
            <div><div class="big ok">{{ p.valid }}</div><div class="vk-muted">válidas</div></div>
            <div><div class="big" [class.bad]="p.errors.length">{{ p.total - p.valid }}</div><div class="vk-muted">con errores</div></div>
            @if (p.updates) { <div><div class="big">{{ p.updates }}</div><div class="vk-muted">actualizarán existentes</div></div> }
          </div>

          @if (p.errors.length) {
            <h3>Errores por fila</h3>
            <p class="vk-muted small">Corrija estas filas en su Excel y vuelva a subirlo, o confirme para importar solo las filas válidas.</p>
            <div class="errs">
              <table class="t">
                <thead><tr><th>Fila</th><th>Columna</th><th>Problema</th></tr></thead>
                <tbody>
                  @for (e of p.errors; track $index) {
                    <tr><td class="vk-mono">{{ e.row }}</td><td>{{ e.column }}</td><td>{{ e.message }}</td></tr>
                  }
                </tbody>
              </table>
            </div>
          }

          @if (p.sample.length) {
            <h3>Muestra de filas válidas</h3>
            <table class="t">
              <tbody>
                @for (s of p.sample; track $index) {
                  <tr>@for (c of s | keyvalue: keepOrder; track c.key) { <td><span class="vk-muted small">{{ c.key }}:</span> {{ c.value }}</td> }</tr>
                }
              </tbody>
            </table>
          }

          <div class="vk-actions">
            <button matButton (click)="reset()">Cancelar</button>
            <button matButton="filled" (click)="commit()" [disabled]="busy() || !p.valid">Importar {{ p.valid }} fila(s)</button>
          </div>
        </section>
      }

      @if (result(); as r) {
        <section class="vk-card done">
          <span class="material-symbols-outlined">task_alt</span>
          <div><strong>Importación completada</strong> en {{ (r.ms / 1000).toFixed(1) }} s: {{ r.created }} creados, {{ r.updated }} actualizados.</div>
        </section>
      }

      <section class="vk-card">
        <h3>Historial</h3>
        <table class="t">
          <thead><tr><th>Fecha</th><th>Tipo</th><th>Archivo</th><th>Estado</th><th class="r">Filas</th></tr></thead>
          <tbody>
            @for (h of history(); track h.id) {
              <tr>
                <td>{{ h.createdAt | date: 'short' }}</td>
                <td>{{ labels[h.kind] }}</td>
                <td>{{ h.fileName }}</td>
                <td><span class="vk-badge" [class.ok]="h.status === 'COMMITTED'" [class.danger]="h.status === 'FAILED'">{{ statusLabel[h.status] ?? h.status }}</span></td>
                <td class="r">{{ h.result ? h.result.created + h.result.updated : h.validCount }} / {{ h.total }}</td>
              </tr>
            } @empty {
              <tr><td colspan="5" class="vk-empty">Sin importaciones</td></tr>
            }
          </tbody>
        </table>
      </section>
    </div>
  `,
  styles: `
    .steps { display: flex; flex-direction: column; gap: 16px; margin-bottom: 16px; }
    .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
    .file { display: inline-flex; gap: 8px; align-items: center; padding: 10px 16px; border: 1px dashed var(--mat-sys-primary); border-radius: 999px; cursor: pointer; color: var(--mat-sys-primary); font: var(--mat-sys-label-large); }
    .file input { display: none; } .file.busy { opacity: .5; }
    .vk-card + .vk-card { margin-top: 16px; }
    .summary { display: flex; gap: 40px; flex-wrap: wrap; margin-bottom: 8px; }
    .big { font: var(--mat-sys-headline-medium); } .ok { color: var(--vk-success); } .bad { color: var(--vk-danger); }
    h3 { font: var(--mat-sys-title-small); margin: 16px 0 8px; }
    .errs { max-height: 360px; overflow: auto; border: 1px solid var(--mat-sys-outline-variant); border-radius: 8px; }
    .t { width: 100%; border-collapse: collapse; }
    .t th, .t td { padding: 6px 10px; border-bottom: 1px solid var(--mat-sys-outline-variant); text-align: left; }
    .t th { font: var(--mat-sys-label-medium); color: var(--vk-muted); position: sticky; top: 0; background: var(--mat-sys-surface); }
    .r { text-align: right !important; } .small { font: var(--mat-sys-body-small); }
    .done { display: flex; gap: 12px; align-items: center; background: var(--vk-success-bg); color: var(--vk-success); }
  `,
})
export class ImportPage implements OnInit {
  private readonly api = inject(CatalogApi);
  private readonly notify = inject(Notify);
  protected readonly auth = inject(AuthService);
  protected readonly kinds = Object.entries(IMPORT_KINDS).map(([key, value]) => ({ key: key as ImportKind, value }));
  protected readonly labels = IMPORT_KINDS;
  protected readonly perms = PERMS;
  protected readonly statusLabel: Record<string, string> = { PREVIEW: 'Sin confirmar', COMMITTED: 'Importado', FAILED: 'Falló' };
  protected kind: ImportKind = 'products';
  protected readonly preview = signal<ImportPreview | null>(null);
  protected readonly result = signal<ImportResult | null>(null);
  protected readonly busy = signal(false);
  protected readonly fileName = signal<string | null>(null);
  protected readonly history = signal<Awaited<ReturnType<CatalogApi['importHistory']>>>([]);
  protected keepOrder = () => 0;

  ngOnInit(): void {
    this.kind = this.kinds.find((k) => this.auth.can(PERMS[k.key]))?.key ?? 'products';
    void this.loadHistory();
  }

  private async loadHistory(): Promise<void> {
    this.history.set(await this.api.importHistory().catch(() => []));
  }

  protected reset(): void {
    this.preview.set(null);
    this.result.set(null);
    this.fileName.set(null);
  }

  protected async template(): Promise<void> {
    try {
      openBlob(await this.api.template(this.kind), `plantilla-${this.kind}.xlsx`);
    } catch (e) {
      this.notify.error(e);
    }
  }

  protected async upload(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.reset();
    this.fileName.set(file.name);
    this.busy.set(true);
    try {
      this.preview.set(await this.api.previewImport(this.kind, file));
    } catch (e) {
      this.notify.error(e);
    } finally {
      this.busy.set(false);
    }
  }

  protected async commit(): Promise<void> {
    const p = this.preview();
    if (!p) return;
    this.busy.set(true);
    try {
      this.result.set(await this.api.commitImport(p.id));
      this.preview.set(null);
      await this.api.lookups(true);
      await this.loadHistory();
    } catch (e) {
      this.notify.error(e);
    } finally {
      this.busy.set(false);
    }
  }
}
