import { AsyncLocalStorage } from 'node:async_hooks';

/** Contexto de la solicitud actual (se llena en el AuthGuard). */
export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
  userId?: string;
  tenantId?: string;
  membershipId?: string | null;
  isSupport?: boolean;
  permissions?: ReadonlySet<string>;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentContext(): RequestContext {
  const ctx = storage.getStore();
  if (!ctx) throw new Error('No hay contexto de solicitud activo');
  return ctx;
}

export function tryCurrentContext(): RequestContext | undefined {
  return storage.getStore();
}
