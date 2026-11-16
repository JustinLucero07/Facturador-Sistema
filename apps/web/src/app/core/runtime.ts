import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import type { RuntimeInfo } from '@vektra/shared-contracts';
import { firstValueFrom } from 'rxjs';

/** API que expone el proceso principal de Electron a la página (preload de la caja de escritorio). */
export interface DesktopBridge {
  version: string;
  printers(): Promise<{ name: string; displayName: string; isDefault: boolean }[]>;
  print(html: string, opts: { printerName?: string | null; widthMm: number }): Promise<void>;
}

declare global {
  interface Window {
    vektraDesktop?: DesktopBridge;
  }
}

/**
 * Modo de ejecución: la misma aplicación corre en el navegador (servidor de la empresa) o dentro
 * de la caja de escritorio, que responde /api/runtime desde su servidor local.
 */
@Injectable({ providedIn: 'root' })
export class RuntimeService {
  private readonly http = inject(HttpClient);
  readonly info = signal<RuntimeInfo>({ mode: 'web' });
  readonly desktop = computed(() => this.info().mode === 'desktop');
  readonly paired = computed(() => !this.desktop() || !!this.info().paired);
  private timer: ReturnType<typeof setInterval> | null = null;

  get bridge(): DesktopBridge | null {
    return window.vektraDesktop ?? null;
  }

  async load(): Promise<void> {
    try {
      this.info.set(await firstValueFrom(this.http.get<RuntimeInfo>('/api/runtime')));
    } catch {
      this.info.set({ mode: 'web' });
    }
    if (this.desktop() && !this.timer) this.timer = setInterval(() => void this.load(), 10_000);
  }

  /** Sincronizar ahora (solo caja de escritorio). */
  async syncNow(): Promise<RuntimeInfo> {
    const info = await firstValueFrom(this.http.post<RuntimeInfo>('/api/desktop/sync', {}));
    this.info.set(info);
    return info;
  }

  async pair(serverUrl: string, code: string): Promise<void> {
    this.info.set(await firstValueFrom(this.http.post<RuntimeInfo>('/api/desktop/pair', { serverUrl, code })));
  }

  outbox() {
    return firstValueFrom(
      this.http.get<{ id: string; type: string; status: string; message: string | null; clientAt: string; attempts: number }[]>('/api/desktop/outbox'),
    );
  }
}
