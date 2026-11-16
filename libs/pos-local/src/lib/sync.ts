import type { PairDeviceResponse, SyncPullResponse, SyncPushResponse } from '@vektra/shared-contracts';
import { CachedConfig, DeviceLink, EngineContext } from './context';
import { fold, HttpError } from './util';

const BATCH = 100;

interface OutboxRow {
  seq: number;
  op_id: string;
  type: string;
  payload: string;
  user_id: string;
  client_at: string;
}

export interface SyncState {
  online: boolean;
  revoked: boolean;
  lastError: string | null;
  running: boolean;
}

/**
 * Sincronización en segundo plano con el servidor:
 *   1. push: envía la cola en orden (lotes de 100). Cada operación es idempotente en el servidor.
 *   2. pull: trae lo que cambió desde el último cursor (o todo, la primera vez).
 * Si no hay internet, la caja sigue vendiendo y reintenta en el siguiente ciclo.
 */
export class SyncClient {
  readonly state: SyncState = { online: false, revoked: false, lastError: null, running: false };
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly ctx: EngineContext,
    private readonly opts: { intervalMs?: number; timeoutMs?: number } = {},
  ) {
    ctx.onOutbox = () => this.trigger();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.run().catch(() => undefined), this.opts.intervalMs ?? 15_000);
    void this.run().catch(() => undefined);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = null;
    this.debounce = null;
  }

  /** Sincronizar pronto (después de una venta), agrupando varias operaciones seguidas. */
  trigger(): void {
    if (!this.timer) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.run().catch(() => undefined), 400);
  }

  counts(): { pending: number; failed: number } {
    const r = this.ctx.db.get<{ pending: number; failed: number }>(
      "SELECT sum(status = 'pending') AS pending, sum(status = 'rejected') AS failed FROM outbox",
    );
    return { pending: r?.pending ?? 0, failed: r?.failed ?? 0 };
  }

  private async request<T>(link: { serverUrl: string; token?: string }, path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${link.serverUrl.replace(/\/$/, '')}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(link.token ? { 'x-device-token': link.token } : {}), ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
      });
    } catch (e) {
      this.state.online = false;
      this.state.lastError = 'Sin conexión con el servidor';
      throw new HttpError(503, `No se pudo conectar con el servidor (${(e as Error).message})`);
    }
    this.state.online = true;
    const text = await res.text();
    const body = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) {
      const message = (body as { message?: string } | null)?.message ?? `Error ${res.status} del servidor`;
      if (res.status === 401 || res.status === 403) this.state.revoked = !!link.token;
      this.state.lastError = message;
      throw new HttpError(res.status, message);
    }
    return body as T;
  }

  /** Vincula la caja con el código generado en la web y descarga todo el catálogo. */
  async pair(serverUrl: string, code: string): Promise<void> {
    const url = serverUrl.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new HttpError(422, 'Dirección del servidor inválida (ej. https://facturas.miempresa.com)');
    const prev = this.ctx.link;
    const res = await this.request<PairDeviceResponse>({ serverUrl: url }, '/api/devices/pair', {
      method: 'POST',
      body: JSON.stringify({ code, fingerprint: this.ctx.opts.fingerprint, appVersion: this.ctx.opts.appVersion }),
    });
    if (prev && prev.deviceId !== res.deviceId) {
      if (this.counts().pending > 0) {
        throw new HttpError(409, 'Esta computadora tiene ventas sin enviar de otra caja. Conéctela a su servidor original antes de vincularla de nuevo.');
      }
      this.wipe();
    }
    const link: DeviceLink = {
      serverUrl: url,
      deviceId: res.deviceId,
      tenantId: res.tenantId,
      emissionPointId: res.emissionPointId,
      token: res.token,
      linkKey: res.linkKey,
      publicBaseUrl: res.publicBaseUrl,
      pairedAt: new Date().toISOString(),
    };
    this.ctx.db.setMeta('device', link);
    if (!prev || prev.deviceId !== res.deviceId) this.ctx.db.run("DELETE FROM meta WHERE key IN ('cursor', 'config', 'lastSyncAt')");
    this.state.revoked = false;
    await this.run();
    if (!this.ctx.config) throw new HttpError(503, this.state.lastError ?? 'No se pudo descargar la información del servidor');
  }

  private wipe(): void {
    this.ctx.db.tx(() => {
      for (const t of ['users', 'products', 'product_units', 'product_barcodes', 'product_prices', 'parties', 'stock', 'sequences', 'cash_sessions', 'cash_movements', 'documents', 'quotes', 'outbox']) {
        this.ctx.db.run(`DELETE FROM ${t}`);
      }
      this.ctx.db.run('DELETE FROM meta');
    });
  }

  /** Un ciclo completo (una sola ejecución a la vez). */
  run(): Promise<void> {
    this.inflight ??= (async () => {
      // Ceder antes de empezar: así `inflight` ya está asignado cuando el finally lo limpia.
      await Promise.resolve();
      this.state.running = true;
      try {
        const link = this.ctx.link;
        if (!link) return;
        await this.push(link);
        await this.pull(link);
        this.ctx.db.setMeta('lastSyncAt', this.ctx.now().toISOString());
        this.state.lastError = null;
      } finally {
        this.state.running = false;
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  private async push(link: DeviceLink): Promise<void> {
    for (;;) {
      const batch = this.ctx.db.all<OutboxRow>("SELECT * FROM outbox WHERE status = 'pending' ORDER BY seq LIMIT ?", BATCH);
      if (!batch.length) return;
      const counts = this.counts();
      this.ctx.db.run(`UPDATE outbox SET attempts = attempts + 1 WHERE seq IN (${batch.map(() => '?').join(',')})`, ...batch.map((b) => b.seq));
      const res = await this.request<SyncPushResponse>(link, '/api/sync/push', {
        method: 'POST',
        body: JSON.stringify({
          ops: batch.map((b) => ({ opId: b.op_id, userId: b.user_id, clientAt: b.client_at, type: b.type, payload: JSON.parse(b.payload) })),
          pending: counts.pending,
          failed: counts.failed,
          appVersion: this.ctx.opts.appVersion,
        }),
      });
      const byId = new Map(batch.map((b) => [b.op_id, b]));
      this.ctx.db.tx(() => {
        for (const r of res.results) {
          const op = byId.get(r.opId);
          if (!op) continue;
          const ok = r.status !== 'rejected';
          this.ctx.db.run('UPDATE outbox SET status = ?, message = ?, sent_at = ? WHERE op_id = ?', ok ? 'done' : 'rejected', r.message ?? null, res.serverTime, r.opId);
          if (op.type === 'invoice.issue') {
            const documentId = (JSON.parse(op.payload) as { documentId: string }).documentId;
            if (ok) this.ctx.db.run("UPDATE documents SET status = 'SIGNED' WHERE id = ? AND status = 'PENDING_SYNC'", documentId);
            else this.ctx.db.run("UPDATE documents SET status = 'REJECTED_SYNC', message = ? WHERE id = ?", r.message ?? 'Rechazada por el servidor', documentId);
          }
        }
      });
      if (res.results.length < batch.length) return;
    }
  }

  private async pull(link: DeviceLink): Promise<void> {
    const cursor = this.ctx.db.meta<string>('cursor');
    const data = await this.request<SyncPullResponse>(link, `/api/sync/pull${cursor ? `?since=${encodeURIComponent(cursor)}` : ''}`);
    this.applyPull(data);
  }

  applyPull(data: SyncPullResponse): void {
    const db = this.ctx.db;
    db.tx(() => {
      const { products, parties, stock, documents, users, cursor, serverTime: _s, full, sequences, ...config } = data;
      void _s;
      db.setMeta('config', config satisfies CachedConfig);
      db.setMeta('cursor', cursor);

      db.run('DELETE FROM users');
      for (const u of users) {
        db.run('INSERT INTO users (id, email, full_name, password_hash, active, permissions) VALUES (?, ?, ?, ?, ?, ?)', u.id, u.email.toLowerCase(), u.fullName, u.passwordHash, u.active ? 1 : 0, JSON.stringify(u.permissions));
      }

      if (full) {
        // Se conservan solo los productos y clientes creados aquí que aún no llegan al servidor.
        const pendingIds = (type: string) =>
          db.all<{ id: string }>("SELECT json_extract(payload, '$.id') AS id FROM outbox WHERE status = 'pending' AND type = ?", type).map((r) => r.id);
        const keepProducts = pendingIds('product.create');
        const keepParties = pendingIds('party.upsert');
        const notIn = (ids: string[]) => (ids.length ? `WHERE id NOT IN (${ids.map(() => '?').join(',')})` : '');
        const notInProduct = (ids: string[]) => (ids.length ? `WHERE product_id NOT IN (${ids.map(() => '?').join(',')})` : '');
        db.run(`DELETE FROM products ${notIn(keepProducts)}`, ...keepProducts);
        for (const t of ['product_units', 'product_barcodes', 'product_prices']) db.run(`DELETE FROM ${t} ${notInProduct(keepProducts)}`, ...keepProducts);
        db.run(`DELETE FROM parties ${notIn(keepParties)}`, ...keepParties);
        db.run('DELETE FROM stock');
      }

      for (const p of products) {
        db.run('DELETE FROM product_units WHERE product_id = ?', p.id);
        db.run('DELETE FROM product_barcodes WHERE product_id = ?', p.id);
        db.run('DELETE FROM product_prices WHERE product_id = ?', p.id);
        db.run(
          `INSERT INTO products (id, code, name, aux_code, unit_id, tax_rate_id, is_service, active, search, local) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
           ON CONFLICT (id) DO UPDATE SET code = excluded.code, name = excluded.name, aux_code = excluded.aux_code, unit_id = excluded.unit_id,
             tax_rate_id = excluded.tax_rate_id, is_service = excluded.is_service, active = excluded.active, search = excluded.search, local = 0`,
          p.id,
          p.code,
          p.name,
          p.auxCode,
          p.unitId,
          p.taxRateId,
          p.isService ? 1 : 0,
          p.active ? 1 : 0,
          fold(`${p.code} ${p.name}`),
        );
        for (const u of p.units) db.run('INSERT OR REPLACE INTO product_units (id, product_id, unit_id, factor, is_base) VALUES (?, ?, ?, ?, ?)', u.id, p.id, u.unitId, u.factor, u.isBase ? 1 : 0);
        for (const b of p.barcodes) db.run('INSERT OR REPLACE INTO product_barcodes (barcode, product_id, product_unit_id) VALUES (?, ?, ?)', b.barcode, p.id, b.productUnitId);
        for (const x of p.prices) db.run('INSERT OR REPLACE INTO product_prices (price_list_id, product_unit_id, product_id, price) VALUES (?, ?, ?, ?)', x.priceListId, x.productUnitId, p.id, x.price);
      }

      for (const p of parties) {
        db.run('DELETE FROM parties WHERE identification = ? AND id <> ?', p.identification, p.id);
        db.run(
          `INSERT INTO parties (id, id_type, identification, name, trade_name, email, phone, address, price_list_id, credit_limit, credit_days, active, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET id_type = excluded.id_type, identification = excluded.identification, name = excluded.name, trade_name = excluded.trade_name,
             email = excluded.email, phone = excluded.phone, address = excluded.address, price_list_id = excluded.price_list_id,
             credit_limit = excluded.credit_limit, credit_days = excluded.credit_days, active = excluded.active`,
          p.id,
          p.idType,
          p.identification,
          p.name,
          p.tradeName,
          p.email,
          p.phone,
          p.address,
          p.priceListId,
          p.creditLimit,
          p.creditDays,
          p.active ? 1 : 0,
          p.updatedAt,
        );
      }

      for (const s of stock) db.run('INSERT OR REPLACE INTO stock (product_id, quantity) VALUES (?, ?)', s.productId, s.quantity);

      // El secuencial nunca retrocede: se usa el mayor entre la caja y el servidor.
      for (const [docType, next] of Object.entries(sequences)) {
        db.run(
          'INSERT INTO sequences (doc_type, next_value) VALUES (?, ?) ON CONFLICT (doc_type) DO UPDATE SET next_value = max(next_value, excluded.next_value)',
          docType,
          next,
        );
      }

      for (const d of documents) {
        db.run(
          "UPDATE documents SET status = ?, authorization_number = ?, authorized_at = ?, message = ? WHERE id = ? AND status <> 'PENDING_SYNC'",
          d.status,
          d.authorizationNumber,
          d.authorizedAt,
          d.message,
          d.id,
        );
      }
    });
  }
}
