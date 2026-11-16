import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import type { LicenseStatus } from '@vektra/shared-contracts';
import { firstValueFrom } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class LicenseStore {
  private readonly http = inject(HttpClient);
  readonly status = signal<LicenseStatus | null>(null);

  /** Aviso visible si la emisión está bloqueada o quedan menos de 24 h sin conexión con Vektra. */
  readonly banner = computed(() => {
    const s = this.status();
    if (!s) return null;
    if (!s.canIssueDocuments) return { level: 'danger' as const, message: `${s.message} El sistema está en modo solo lectura.` };
    if (s.state === 'valid' && s.hoursLeft !== null && s.hoursLeft < 24) return { level: 'warn' as const, message: s.message };
    return null;
  });

  async load(): Promise<void> {
    try {
      this.status.set(await firstValueFrom(this.http.get<LicenseStatus>('/api/license')));
    } catch {
      /* el aviso no es crítico */
    }
  }
}
