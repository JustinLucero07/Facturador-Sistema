import type { RuntimeInfo, EInvoiceConfig, LicenseStatus } from '@vektra/shared-contracts';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';
import { LocalAuth, LocalUser, requirePerm } from './auth';
import { LocalCash } from './cash';
import { LocalCatalog } from './catalog';
import { EngineContext } from './context';
import { LocalCreditNotes } from './credit-notes';
import { LocalSales } from './sales';
import { SyncClient } from './sync';
import { HttpError, json } from './util';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
};

type Handler = (req: Req) => unknown | Promise<unknown>;
interface Req {
  method: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  raw: IncomingMessage;
  res: ServerResponse;
  user: () => LocalUser;
}

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

/**
 * Servidor HTTP de la caja (solo escucha en 127.0.0.1). Sirve la misma aplicación web y responde
 * los endpoints que usa el punto de venta con los datos locales, con el mismo formato que la API.
 */
export class LocalServer {
  private readonly routes: Route[] = [];
  private server: Server | null = null;

  constructor(
    private readonly ctx: EngineContext,
    private readonly auth: LocalAuth,
    private readonly catalog: LocalCatalog,
    private readonly cash: LocalCash,
    private readonly sales: LocalSales,
    private readonly sync: SyncClient,
    private readonly webRoot: string | null,
    private readonly notes: LocalCreditNotes = new LocalCreditNotes(ctx),
  ) {
    this.register();
  }

  private on(method: string, path: string, handler: Handler): void {
    const keys: string[] = [];
    const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, k: string) => (keys.push(k), '([^/]+)'))}$`);
    this.routes.push({ method, pattern, keys, handler });
  }

  runtime(): RuntimeInfo {
    const link = this.ctx.link;
    const counts = this.sync.counts();
    return {
      mode: 'desktop',
      online: this.sync.state.online,
      paired: !!link && !!this.ctx.config,
      lastSyncAt: this.ctx.lastSyncAt()?.toISOString() ?? null,
      pendingOps: counts.pending,
      failedOps: counts.failed,
      offlineHoursLeft: this.ctx.offlineHoursLeft(),
      serverUrl: link?.serverUrl ?? null,
      deviceName: this.ctx.config?.device.name ?? null,
      appVersion: this.ctx.opts.appVersion,
    };
  }

  private config(): EInvoiceConfig {
    const cfg = this.ctx.requireConfig();
    const ep = cfg.emissionPoint;
    return {
      taxRates: cfg.taxRates,
      paymentMethods: [],
      idTypes: cfg.idTypes,
      finalConsumer: cfg.finalConsumer,
      emissionPoints: [{ id: ep.id, establishmentId: ep.establishmentId, label: `${ep.establishmentCode}-${ep.code} · ${ep.name} (${ep.establishmentName})` }],
      posPaymentMethods: cfg.paymentMethods,
      environment: cfg.company.environment,
      certificate: cfg.certificate,
    };
  }

  private license(): LicenseStatus {
    const cfg = this.ctx.requireConfig();
    const left = this.ctx.offlineHoursLeft();
    if (left !== null && left <= 0) {
      return { ...cfg.license, canIssueDocuments: false, message: `La caja lleva más de ${cfg.maxOfflineHours} horas sin sincronizar. Conéctese a internet.` };
    }
    return cfg.license;
  }

  private register(): void {
    const s = this.sales;
    this.on('GET', '/api/runtime', () => this.runtime());
    this.on('GET', '/api/health', () => ({ status: 'ok', time: new Date().toISOString() }));

    // Vinculación: libre la primera vez; después solo un usuario con permiso de estructura.
    this.on('POST', '/api/desktop/pair', async (r) => {
      if (this.ctx.link && this.ctx.config) requirePerm(r.user(), 'structure.manage');
      const b = (r.body ?? {}) as { serverUrl?: string; code?: string };
      await this.sync.pair(String(b.serverUrl ?? ''), String(b.code ?? ''));
      return this.runtime();
    });
    this.on('POST', '/api/desktop/sync', async (r) => {
      r.user();
      await this.sync.run().catch(() => undefined);
      return this.runtime();
    });
    this.on('GET', '/api/desktop/outbox', (r) => {
      r.user();
      return this.ctx.db
        .all<{ op_id: string; type: string; status: string; message: string | null; client_at: string; attempts: number }>(
          "SELECT op_id, type, status, message, client_at, attempts FROM outbox WHERE status <> 'done' ORDER BY seq DESC LIMIT 200",
        )
        .map((o) => ({ id: o.op_id, type: o.type, status: o.status, message: o.message, clientAt: o.client_at, attempts: o.attempts }));
    });

    // Sesión
    this.on('POST', '/api/auth/login', async (r) => {
      const b = (r.body ?? {}) as { email?: string; password?: string };
      const { response, refreshToken } = await this.auth.login(String(b.email ?? ''), String(b.password ?? ''));
      r.res.setHeader('set-cookie', `vk_rt=${refreshToken}; Path=/api/auth; HttpOnly; SameSite=Strict`);
      return response;
    });
    this.on('POST', '/api/auth/refresh', (r) => this.auth.refreshToken(cookie(r.raw, 'vk_rt')));
    this.on('POST', '/api/auth/logout', (r) => {
      this.auth.logout(cookie(r.raw, 'vk_rt'));
      r.res.setHeader('set-cookie', 'vk_rt=; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=0');
      return {};
    });
    this.on('GET', '/api/auth/me', (r) => this.auth.session(r.user()));
    this.on('GET', '/api/license', (r) => (r.user(), this.license()));

    // Facturación
    this.on('GET', '/api/einvoice/config', (r) => (r.user(), this.config()));
    this.on('POST', '/api/einvoice/invoices', (r) => s.issue(r.user(), r.body));
    this.on('GET', '/api/einvoice/documents/:id', (r) => (r.user(), this.notes.has(r.params['id']) ? this.notes.detail(r.params['id']) : s.detail(r.params['id'])));
    // Devoluciones (nota de crédito)
    this.on('GET', '/api/einvoice/invoices/find', (r) => (requirePerm(r.user(), 'sales.void'), this.notes.find(r.query.get('q') ?? '')));
    this.on('GET', '/api/einvoice/documents/:id/creditable', (r) => (requirePerm(r.user(), 'sales.void'), this.notes.creditable(r.params['id'])));
    this.on('POST', '/api/einvoice/credit-notes', (r) => this.notes.issue(r.user(), r.body));
    this.on('POST', '/api/einvoice/documents/:id/email', (r) => {
      const email = (r.body as { email?: string } | null)?.email;
      s.email(r.user(), r.params['id'], email);
      return null;
    });
    this.on('GET', '/api/pos/tickets/:id', (r) => {
      r.user();
      const id = r.params['id'];
      return this.notes.has(id) ? this.notes.ticket(id, (doc) => s.ticketFromRow(doc)) : s.ticket(id);
    });

    // Catálogo y clientes
    this.on('GET', '/api/products/search', (r) => {
      requirePerm(r.user(), 'catalog.read');
      return this.catalog.search(r.query.get('q') ?? '', r.query.get('priceListId') || undefined, Number(r.query.get('limit') ?? 20));
    });
    this.on('POST', '/api/products/quick', (r) => this.catalog.quickProduct(r.user(), r.body));
    this.on('GET', '/api/catalog/lookups', (r) => (r.user(), this.catalog.lookups()));
    this.on('GET', '/api/parties/by-identification/:id', (r) => {
      requirePerm(r.user(), 'customers.read');
      return this.catalog.partyByIdentification(decodeURIComponent(r.params['id']));
    });
    this.on('POST', '/api/parties', (r) => this.catalog.saveParty(r.user(), null, r.body));
    this.on('PATCH', '/api/parties/:id', (r) => (this.catalog.saveParty(r.user(), r.params['id'], r.body), null));

    // Caja
    this.on('GET', '/api/cash/current', (r) => this.cash.current(r.query.get('emissionPointId') ?? '', r.user()));
    this.on('POST', '/api/cash/sessions', (r) => this.cash.open(r.user(), r.body));
    this.on('GET', '/api/cash/sessions/:id', (r) => this.cash.summary(r.params['id'], r.user()));
    this.on('POST', '/api/cash/sessions/:id/movements', (r) => this.cash.movement(r.user(), r.params['id'], r.body));
    this.on('POST', '/api/cash/sessions/:id/close', (r) => this.cash.close(r.user(), r.params['id'], r.body));

    // Proformas
    this.on('POST', '/api/quotes', (r) => s.createQuote(r.user(), r.body));
    this.on('GET', '/api/quotes', (r) => (requirePerm(r.user(), 'sales.quote'), s.quotes(r.query.get('search') ?? '')));
    this.on('GET', '/api/quotes/:id', (r) => (requirePerm(r.user(), 'sales.quote'), s.quote(r.params['id'])));
  }

  async handle(raw: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(raw.url ?? '/', 'http://127.0.0.1');
    const method = raw.method ?? 'GET';
    res.setHeader('x-content-type-options', 'nosniff');
    if (!url.pathname.startsWith('/api/')) return this.serveStatic(url.pathname, res);

    const route = this.routes.find((r) => r.method === method && r.pattern.test(url.pathname));
    try {
      if (!route) throw new HttpError(404, 'Esta función está disponible solo en la versión web del sistema');
      const m = route.pattern.exec(url.pathname) as RegExpExecArray;
      const params = Object.fromEntries(route.keys.map((k, i) => [k, m[i + 1]]));
      let cached: LocalUser | null = null;
      const body = ['POST', 'PATCH', 'PUT'].includes(method) ? await readJson(raw) : null;
      const out = await route.handler({
        method,
        params,
        query: url.searchParams,
        body,
        raw,
        res,
        user: () => (cached ??= this.auth.authenticate(raw.headers.authorization)),
      });
      if (out === null || out === undefined) {
        res.statusCode = method === 'GET' ? 200 : 204;
        if (method === 'GET') {
          res.setHeader('content-type', 'application/json');
          res.end('null');
        } else res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(out));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const message = e instanceof HttpError ? e.message : 'Ocurrió un error inesperado en la caja. Intente nuevamente.';
      if (!(e instanceof HttpError)) console.error('[pos-local]', e);
      res.statusCode = status;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ statusCode: status, message, ...(e instanceof HttpError && e.details?.length ? { details: e.details } : {}) }));
    }
  }

  private serveStatic(pathname: string, res: ServerResponse): void {
    if (!this.webRoot) {
      res.statusCode = 404;
      res.end('Sin interfaz');
      return;
    }
    const root = resolve(this.webRoot);
    let file = normalize(join(root, decodeURIComponent(pathname)));
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html'); // rutas de la SPA
    res.statusCode = 200;
    res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
    // Solo los archivos con hash en el nombre (build de producción) se guardan en caché para siempre.
    res.setHeader('cache-control', /-[A-Z0-9]{8,}\.(js|css|woff2?)$/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache');
    createReadStream(file).pipe(res);
  }

  listen(port: number, host = '127.0.0.1'): Promise<number> {
    return new Promise((ok, fail) => {
      this.server = createServer((req, res) => void this.handle(req, res));
      this.server.once('error', fail);
      this.server.listen(port, host, () => ok((this.server?.address() as AddressInfo).port));
    });
  }

  close(): Promise<void> {
    return new Promise((ok) => (this.server ? this.server.close(() => ok()) : ok()));
  }
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 5_000_000) throw new HttpError(413, 'Solicitud demasiado grande');
    chunks.push(c as Buffer);
  }
  return json(Buffer.concat(chunks).toString('utf8'), null);
}
