import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

/**
 * Base local de la caja de escritorio (SQLite integrado en Node/Electron: sin módulos nativos).
 * Guarda una copia del catálogo para vender sin conexión, las ventas de la caja y la cola de
 * operaciones pendientes de enviar al servidor (outbox).
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, full_name TEXT NOT NULL,
    password_hash TEXT NOT NULL, active INTEGER NOT NULL, permissions TEXT NOT NULL
  );

  CREATE TABLE products (
    id TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, aux_code TEXT, unit_id TEXT NOT NULL,
    tax_rate_id TEXT NOT NULL, is_service INTEGER NOT NULL, active INTEGER NOT NULL,
    search TEXT NOT NULL, local INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX products_code ON products (code COLLATE NOCASE);
  CREATE TABLE product_units (id TEXT PRIMARY KEY, product_id TEXT NOT NULL, unit_id TEXT NOT NULL, factor TEXT NOT NULL, is_base INTEGER NOT NULL);
  CREATE INDEX product_units_product ON product_units (product_id);
  CREATE TABLE product_barcodes (barcode TEXT PRIMARY KEY, product_id TEXT NOT NULL, product_unit_id TEXT);
  CREATE INDEX product_barcodes_product ON product_barcodes (product_id);
  CREATE TABLE product_prices (price_list_id TEXT NOT NULL, product_unit_id TEXT NOT NULL, product_id TEXT NOT NULL, price TEXT NOT NULL, PRIMARY KEY (price_list_id, product_unit_id));
  CREATE INDEX product_prices_product ON product_prices (product_id);

  CREATE TABLE parties (
    id TEXT PRIMARY KEY, id_type TEXT NOT NULL, identification TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    trade_name TEXT, email TEXT, phone TEXT, address TEXT, price_list_id TEXT,
    credit_limit TEXT NOT NULL DEFAULT '0.00', credit_days INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  -- Stock del servidor (última sincronización). El disponible resta las ventas aún no enviadas.
  CREATE TABLE stock (product_id TEXT PRIMARY KEY, quantity TEXT NOT NULL);

  CREATE TABLE sequences (doc_type TEXT PRIMARY KEY, next_value INTEGER NOT NULL);

  CREATE TABLE cash_sessions (
    id TEXT PRIMARY KEY, status TEXT NOT NULL, opened_by TEXT NOT NULL, opened_at TEXT NOT NULL, opening_amount TEXT NOT NULL,
    closed_by TEXT, closed_at TEXT, expected TEXT, counted TEXT, denominations TEXT, difference TEXT, notes TEXT
  );
  CREATE UNIQUE INDEX cash_one_open ON cash_sessions (status) WHERE status = 'OPEN';
  CREATE TABLE cash_movements (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, amount TEXT NOT NULL, reason TEXT NOT NULL, created_by TEXT NOT NULL, at TEXT NOT NULL);

  CREATE TABLE documents (
    id TEXT PRIMARY KEY, sequential INTEGER NOT NULL UNIQUE, number TEXT NOT NULL, access_key TEXT NOT NULL UNIQUE,
    issued_at TEXT NOT NULL, cash_session_id TEXT, created_by TEXT, quote_id TEXT,
    buyer TEXT NOT NULL, lines TEXT NOT NULL, totals TEXT NOT NULL, payments TEXT NOT NULL, total TEXT NOT NULL,
    status TEXT NOT NULL, authorization_number TEXT, authorized_at TEXT, message TEXT
  );
  CREATE INDEX documents_session ON documents (cash_session_id);
  CREATE INDEX documents_status ON documents (status);

  CREATE TABLE quotes (
    id TEXT PRIMARY KEY, number INTEGER NOT NULL, created_at TEXT NOT NULL, created_by TEXT,
    request TEXT NOT NULL, total TEXT NOT NULL, valid_until TEXT NOT NULL, document_id TEXT
  );

  -- Cola de operaciones para el servidor (orden estricto por seq).
  CREATE TABLE outbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT NOT NULL UNIQUE, type TEXT NOT NULL, payload TEXT NOT NULL,
    user_id TEXT NOT NULL, client_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    message TEXT, attempts INTEGER NOT NULL DEFAULT 0, sent_at TEXT
  );
  CREATE INDEX outbox_status ON outbox (status, seq);
  `,
  // v2 (Fase 5): notas de crédito emitidas en la caja
  `
  CREATE TABLE credit_notes (
    id TEXT PRIMARY KEY, sequential INTEGER NOT NULL UNIQUE, number TEXT NOT NULL, access_key TEXT NOT NULL UNIQUE,
    issued_at TEXT NOT NULL, invoice_id TEXT NOT NULL, created_by TEXT, reason TEXT NOT NULL, refund_method TEXT NOT NULL,
    cash_movement_id TEXT, buyer TEXT NOT NULL, lines TEXT NOT NULL, totals TEXT NOT NULL, total TEXT NOT NULL,
    status TEXT NOT NULL, authorization_number TEXT, authorized_at TEXT, message TEXT
  );
  CREATE INDEX credit_notes_invoice ON credit_notes (invoice_id);
  ALTER TABLE cash_movements ADD COLUMN document_id TEXT;
  `,
];

export type Row = Record<string, SQLInputValue>;

export class LocalDb {
  readonly sql: DatabaseSync;

  constructor(path: string) {
    this.sql = new DatabaseSync(path);
    this.sql.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    const version = (this.sql.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.sql.exec(MIGRATIONS[v]);
        this.sql.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  all<T>(query: string, ...params: SQLInputValue[]): T[] {
    return this.sql.prepare(query).all(...params) as T[];
  }

  get<T>(query: string, ...params: SQLInputValue[]): T | undefined {
    return this.sql.prepare(query).get(...params) as T | undefined;
  }

  run(query: string, ...params: SQLInputValue[]): void {
    this.sql.prepare(query).run(...params);
  }

  /** Transacción síncrona (BEGIN IMMEDIATE): una sola escritura a la vez, todo o nada. */
  tx<T>(fn: () => T): T {
    if (this.sql.isTransaction) return fn();
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.sql.exec('COMMIT');
      return out;
    } catch (e) {
      this.sql.exec('ROLLBACK');
      throw e;
    }
  }

  meta<T>(key: string): T | null {
    const r = this.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key);
    return r ? (JSON.parse(r.value) as T) : null;
  }

  setMeta(key: string, value: unknown): void {
    this.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  }

  close(): void {
    this.sql.close();
  }
}
