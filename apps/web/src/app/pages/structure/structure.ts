import { HttpClient } from '@angular/common/http';
import { Component, inject, OnInit, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatTooltipModule } from '@angular/material/tooltip';
import type { EmissionPointItem, EstablishmentItem, WarehouseItem } from '@vektra/shared-contracts';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth.service';
import { Notify } from '../../core/notify.service';
import { StructureDialog, StructureDialogData } from './structure-dialog';

@Component({
  selector: 'vk-structure',
  imports: [MatExpansionModule, MatButtonModule, MatTooltipModule],
  templateUrl: './structure.html',
  styleUrl: './structure.scss',
})
export class StructurePage implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(Notify);
  protected readonly auth = inject(AuthService);
  protected readonly items = signal<EstablishmentItem[]>([]);

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  protected async load(): Promise<void> {
    try {
      this.items.set(await firstValueFrom(this.http.get<EstablishmentItem[]>('/api/establishments')));
    } catch (e) {
      this.notify.error(e);
    }
  }

  protected editEstablishment(e?: EstablishmentItem): void {
    this.open({ kind: 'establishment', item: e });
  }

  protected editPoint(est: EstablishmentItem, p?: EmissionPointItem): void {
    this.open({ kind: 'emissionPoint', establishmentId: est.id, item: p, suggestedCode: this.nextCode(est.emissionPoints.map((x) => x.code)) });
  }

  protected editWarehouse(est: EstablishmentItem, w?: WarehouseItem): void {
    this.open({ kind: 'warehouse', establishmentId: est.id, item: w });
  }

  protected newEstablishment(): void {
    this.open({ kind: 'establishment', suggestedCode: this.nextCode(this.items().map((x) => x.code)) });
  }

  private nextCode(codes: string[]): string {
    const max = codes.reduce((m, c) => Math.max(m, Number(c)), 0);
    return String(max + 1).padStart(3, '0');
  }

  private open(data: StructureDialogData): void {
    this.dialog
      .open(StructureDialog, { data, panelClass: 'vk-dialog' })
      .afterClosed()
      .subscribe((saved) => saved && this.load());
  }
}
