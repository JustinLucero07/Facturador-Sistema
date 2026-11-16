import type { LoginResponse, SessionInfo } from '@vektra/shared-contracts';
import { argon2Verify } from 'hash-wasm';
import { randomBytes } from 'node:crypto';
import { EngineContext } from './context';
import { forbidden, HttpError, json } from './util';

export interface LocalUser {
  id: string;
  email: string;
  fullName: string;
  permissions: Set<string>;
}

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  password_hash: string;
  active: number;
  permissions: string;
}

const ACCESS_TTL_S = 15 * 60;
const REFRESH_TTL_MS = 12 * 3600_000;

/**
 * Sesiones de la caja. Los usuarios y sus hashes de contraseña llegan del servidor en cada
 * sincronización, así el cajero entra con su clave habitual aunque no haya internet.
 * Los tokens viven en memoria (al cerrar la aplicación hay que volver a ingresar).
 */
export class LocalAuth {
  private access = new Map<string, { userId: string; exp: number }>();
  private refresh = new Map<string, { userId: string; exp: number }>();
  private failures = new Map<string, { count: number; until: number }>();

  constructor(private readonly ctx: EngineContext) {}

  private user(id: string): LocalUser | null {
    const r = this.ctx.db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
    if (!r || !r.active) return null;
    return { id: r.id, email: r.email, fullName: r.full_name, permissions: new Set(json<string[]>(r.permissions, [])) };
  }

  session(u: LocalUser): SessionInfo {
    const cfg = this.ctx.requireConfig();
    return {
      user: { id: u.id, email: u.email, fullName: u.fullName, isSupport: false, totpEnabled: false },
      tenant: {
        id: cfg.link.tenantId,
        ruc: cfg.company.ruc,
        legalName: cfg.company.legalName,
        tradeName: cfg.company.tradeName,
        environment: cfg.company.environment,
        modules: [],
      },
      permissions: [...u.permissions],
      tenants: [],
    };
  }

  async login(email: string, password: string): Promise<{ response: LoginResponse; refreshToken: string }> {
    this.ctx.requireConfig();
    const key = email.trim().toLowerCase();
    const f = this.failures.get(key);
    if (f && f.until > Date.now()) throw new HttpError(429, 'Demasiados intentos fallidos. Espere un minuto e intente de nuevo.');
    const row = this.ctx.db.get<UserRow>('SELECT * FROM users WHERE email = ?', key);
    const ok = !!row && row.active === 1 && (await argon2Verify({ password, hash: row.password_hash }).catch(() => false));
    if (!ok || !row) {
      const count = (f?.count ?? 0) + 1;
      this.failures.set(key, { count, until: count >= 5 ? Date.now() + 60_000 : 0 });
      throw new HttpError(401, 'Correo o contraseña incorrectos');
    }
    this.failures.delete(key);
    const user = this.user(row.id) as LocalUser;
    if (!user.permissions.has('sales.create') && !user.permissions.has('cash.operate')) {
      throw forbidden('Su usuario no tiene permiso para usar la caja');
    }
    const accessToken = randomBytes(24).toString('base64url');
    const refreshToken = randomBytes(32).toString('base64url');
    this.access.set(accessToken, { userId: user.id, exp: Date.now() + ACCESS_TTL_S * 1000 });
    this.refresh.set(refreshToken, { userId: user.id, exp: Date.now() + REFRESH_TTL_MS });
    return { response: { step: 'done', accessToken, expiresIn: ACCESS_TTL_S, session: this.session(user) }, refreshToken };
  }

  refreshToken(rt: string | undefined): { accessToken: string; expiresIn: number } {
    const s = rt ? this.refresh.get(rt) : undefined;
    if (!s || s.exp < Date.now() || !this.user(s.userId)) throw new HttpError(401, 'Sesión vencida');
    const accessToken = randomBytes(24).toString('base64url');
    this.access.set(accessToken, { userId: s.userId, exp: Date.now() + ACCESS_TTL_S * 1000 });
    return { accessToken, expiresIn: ACCESS_TTL_S };
  }

  logout(rt: string | undefined): void {
    if (!rt) return;
    const s = this.refresh.get(rt);
    this.refresh.delete(rt);
    if (s) for (const [k, v] of this.access) if (v.userId === s.userId) this.access.delete(k);
  }

  /** Usuario de la solicitud (Authorization: Bearer …). Los permisos se leen en cada llamada. */
  authenticate(header: string | undefined): LocalUser {
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    const s = token ? this.access.get(token) : undefined;
    if (!s || s.exp < Date.now()) throw new HttpError(401, 'Sesión vencida');
    const u = this.user(s.userId);
    if (!u) throw new HttpError(401, 'Su usuario ya no está activo');
    return u;
  }
}

export function requirePerm(u: LocalUser, ...codes: string[]): void {
  if (!codes.every((c) => u.permissions.has(c))) throw forbidden();
}
