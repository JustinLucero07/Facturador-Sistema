import type { SyncPullResponse } from '@vektra/shared-contracts';
import { uuidv7 } from '@vektra/db/uuid';
import { LocalDb } from './db';
import { HttpError, unprocessable } from './util';

/** Datos de vinculación con el servidor (se guardan al vincular la caja). */
export interface DeviceLink {
  serverUrl: string;
  deviceId: string;
  tenantId: string;
  emissionPointId: string;
  token: string;
  linkKey: string;
  publicBaseUrl: string;
  pairedAt: string;
}

/** Configuración recibida en el último pull (sin el catálogo, que va en tablas). */
export type CachedConfig = Omit<SyncPullResponse, 'products' | 'parties' | 'stock' | 'documents' | 'users' | 'cursor' | 'serverTime' | 'full' | 'sequences'>;

export interface EngineOptions {
  appVersion: string;
  /** Identificador estable de la computadora (para la bitácora del servidor) */
  fingerprint: string;
  /** Reloj inyectable (pruebas) */
  now?: () => Date;
}

/** Estado compartido por los módulos del motor local. */
export class EngineContext {
  /** Avisar al sincronizador que hay operaciones nuevas en la cola. */
  onOutbox: () => void = () => undefined;

  constructor(
    readonly db: LocalDb,
    readonly opts: EngineOptions,
  ) {}

  now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }

  get link(): DeviceLink | null {
    return this.db.meta<DeviceLink>('device');
  }

  get config(): CachedConfig | null {
    return this.db.meta<CachedConfig>('config');
  }

  /** Configuración obligatoria: la caja debe estar vinculada y haber sincronizado al menos una vez. */
  requireConfig(): CachedConfig & { link: DeviceLink } {
    const link = this.link;
    const config = this.config;
    if (!link) throw new HttpError(503, 'Esta caja no está vinculada. Vincúlela con el código que se genera en la web.');
    if (!config) throw new HttpError(503, 'La caja aún no descarga los datos del servidor. Conéctese a internet para la primera sincronización.');
    return { ...config, link };
  }

  lastSyncAt(): Date | null {
    const v = this.db.meta<string>('lastSyncAt');
    return v ? new Date(v) : null;
  }

  /** Horas que le quedan a la caja para vender sin sincronizar (null = sin datos). */
  offlineHoursLeft(): number | null {
    const cfg = this.config;
    const last = this.lastSyncAt();
    if (!cfg || !last) return null;
    return Math.max(0, cfg.maxOfflineHours - (this.now().getTime() - last.getTime()) / 3_600_000);
  }

  /** Reglas para emitir: licencia válida (según el servidor) y no exceder el tiempo sin conexión. */
  assertCanIssue(): void {
    const cfg = this.requireConfig();
    if (!cfg.license.canIssueDocuments) throw unprocessable(`${cfg.license.message} No se pueden emitir comprobantes.`);
    const left = this.offlineHoursLeft();
    if (left !== null && left <= 0) {
      throw unprocessable(
        `La caja lleva más de ${cfg.maxOfflineHours} horas sin conectarse al servidor. Conéctese a internet para sincronizar y seguir vendiendo.`,
      );
    }
    if (!cfg.certificate.present || cfg.certificate.level === 'danger') throw unprocessable(cfg.certificate.message);
  }

  /** Agrega una operación a la cola para el servidor (dentro de la transacción del llamador). */
  enqueue(type: string, payload: unknown, userId: string): string {
    const opId = uuidv7();
    this.db.run('INSERT INTO outbox (op_id, type, payload, user_id, client_at) VALUES (?, ?, ?, ?, ?)', opId, type, JSON.stringify(payload), userId, this.now().toISOString());
    queueMicrotask(() => this.onOutbox());
    return opId;
  }

  /** Siguiente número de una serie local (01 factura, PF proforma). La caja es la única dueña del punto. */
  nextSequential(docType: string): number {
    const row = this.db.get<{ next_value: number }>('SELECT next_value FROM sequences WHERE doc_type = ?', docType);
    const value = row?.next_value ?? 1;
    this.db.run(
      'INSERT INTO sequences (doc_type, next_value) VALUES (?, ?) ON CONFLICT (doc_type) DO UPDATE SET next_value = excluded.next_value',
      docType,
      value + 1,
    );
    return value;
  }
}
