import { LocalAuth } from './lib/auth';
import { LocalCash } from './lib/cash';
import { LocalCatalog } from './lib/catalog';
import { EngineContext, EngineOptions } from './lib/context';
import { LocalDb } from './lib/db';
import { LocalSales } from './lib/sales';
import { LocalServer } from './lib/server';
import { SyncClient } from './lib/sync';

export { LocalDb } from './lib/db';
export { EngineContext } from './lib/context';
export type { DeviceLink, CachedConfig, EngineOptions } from './lib/context';
export { SyncClient } from './lib/sync';
export { LocalServer } from './lib/server';

export interface LocalEngine {
  ctx: EngineContext;
  db: LocalDb;
  sync: SyncClient;
  server: LocalServer;
  /** Arranca el servidor HTTP local y la sincronización. Devuelve el puerto. */
  start(port?: number): Promise<number>;
  stop(): Promise<void>;
}

/** Motor de la caja de escritorio: base SQLite + API local + sincronización con el servidor. */
export function createLocalEngine(opts: EngineOptions & { dbPath: string; webRoot: string | null; syncIntervalMs?: number }): LocalEngine {
  const db = new LocalDb(opts.dbPath);
  const ctx = new EngineContext(db, opts);
  const sync = new SyncClient(ctx, { intervalMs: opts.syncIntervalMs });
  const catalog = new LocalCatalog(ctx);
  const server = new LocalServer(ctx, new LocalAuth(ctx), catalog, new LocalCash(ctx), new LocalSales(ctx, catalog), sync, opts.webRoot);
  return {
    ctx,
    db,
    sync,
    server,
    async start(port = 0) {
      const p = await server.listen(port);
      sync.start();
      return p;
    },
    async stop() {
      sync.stop();
      await server.close();
      db.close();
    },
  };
}
