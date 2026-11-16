import type { PrismaClient, Tx } from '@vektra/db';
import type { PaymentMethodDef } from '@vektra/shared-contracts';

export interface WsUrls {
  reception: string;
  authorization: string;
}

export interface SriSettings {
  wsTest: WsUrls;
  wsProduction: WsUrls;
  timeoutMs: number;
  authWaitSeconds: number;
  finalConsumer: { id: string; name: string; maxAmount: string };
  rimpeLegends: Record<string, string>;
  xmlVersions: Record<string, string>;
  currency: string;
  providerRuc: string | null;
  paymentMethods: PaymentMethodDef[];
  /** Horas que una caja de escritorio puede vender sin sincronizar */
  desktopMaxOfflineHours: number;
  /** Plazo de envío de comprobantes emitidos sin conexión (null = no configurado) */
  offlineSendDeadlineHours: number | null;
}

type Db = PrismaClient | Tx;

let cache: { at: number; value: SriSettings } | null = null;
const TTL = 60_000;

export function invalidateSriSettings(): void {
  cache = null;
}

/** Parámetros del SRI desde la tabla sri_setting (global). Caché de 1 minuto. */
export async function loadSriSettings(db: Db): Promise<SriSettings> {
  if (cache && Date.now() - cache.at < TTL) return cache.value;
  const rows = await db.sriSetting.findMany();
  const get = <T>(key: string, fallback: T): T => {
    const row = rows.find((r) => r.key === key);
    return row ? (row.value as T) : fallback;
  };
  const required = <T>(key: string): T => {
    const row = rows.find((r) => r.key === key);
    if (!row) throw new Error(`Falta el parámetro SRI "${key}". Ejecute el seed de la base de datos.`);
    return row.value as T;
  };
  const value: SriSettings = {
    wsTest: required<WsUrls>('ws.test'),
    wsProduction: required<WsUrls>('ws.production'),
    timeoutMs: get('ws.timeout_ms', 30000),
    authWaitSeconds: get('authorization.wait_seconds', 3),
    finalConsumer: required('final_consumer'),
    rimpeLegends: get('rimpe_legends', {}),
    xmlVersions: get('xml_versions', { '01': '1.1.0' }),
    currency: get('currency', 'DOLAR'),
    providerRuc: get<string | null>('provider_ruc', null),
    paymentMethods: get<PaymentMethodDef[]>('payment_methods', []),
    desktopMaxOfflineHours: get<number>('desktop.max_offline_hours', 48),
    offlineSendDeadlineHours: get<number | null>('offline.send_deadline_hours', null),
  };
  cache = { at: Date.now(), value };
  return value;
}

export function wsFor(settings: SriSettings, environment: number): WsUrls {
  return environment === 2 ? settings.wsProduction : settings.wsTest;
}
