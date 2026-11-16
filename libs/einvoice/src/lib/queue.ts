import type { JobsOptions, Queue } from 'bullmq';

export const SRI_QUEUE = 'sri';

export type SriJobName = 'send' | 'authorize' | 'email' | 'sweep' | 'cert-alerts';

export interface SriJobData {
  tenantId: string;
  documentId: string;
  /** Solo para reenvío manual de correo */
  email?: string;
}

/**
 * Política de reintentos: si el SRI no responde, el comprobante queda "en contingencia" y se reintenta
 * con espera exponencial; el barrido periódico del worker recoge cualquier pendiente que haya quedado
 * fuera de la cola (reinicio de Redis, etc.).
 */
const RETRY: Record<'send' | 'authorize' | 'email', Pick<JobsOptions, 'attempts' | 'backoff'>> = {
  send: { attempts: 12, backoff: { type: 'exponential', delay: 15_000 } },
  authorize: { attempts: 16, backoff: { type: 'exponential', delay: 5_000 } },
  email: { attempts: 5, backoff: { type: 'exponential', delay: 60_000 } },
};

const ALIVE = new Set(['waiting', 'delayed', 'active', 'prioritized', 'waiting-children']);

/** Encola un trabajo por comprobante evitando duplicados (un trabajo vivo por tipo y documento). */
export async function enqueueSriJob(queue: Queue, name: 'send' | 'authorize' | 'email', data: SriJobData, opts: { delayMs?: number; force?: boolean } = {}): Promise<boolean> {
  const jobId = `${name}-${data.documentId}`;
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (ALIVE.has(state) && !opts.force) return false;
    await existing.remove().catch(() => undefined);
  }
  await queue.add(name, data, { jobId, delay: opts.delayMs ?? 0, removeOnComplete: true, removeOnFail: { age: 7 * 86_400 }, ...RETRY[name] });
  return true;
}

/** redis://[:password@]host:port[/db] → opciones de conexión para BullMQ. */
export function redisConnection(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(u.pathname.length > 1 ? { db: Number(u.pathname.slice(1)) } : {}),
    maxRetriesPerRequest: null,
  };
}
