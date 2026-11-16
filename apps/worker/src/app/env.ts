import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  HUB_URL: z.string().default(''),
  INSTALLATION_ID: z.string().default(''),
  INSTALLATION_SECRET: z.string().default(''),
  LICENSE_PUBLIC_KEY: z.string().default(''),
  LICENSE_CHECK_MINUTES: z.coerce.number().int().min(1).default(60),
  APP_VERSION: z.string().default('0.0.1'),
});
export type WorkerEnv = z.infer<typeof schema>;

let cached: WorkerEnv | null = null;
export function workerEnv(): WorkerEnv {
  cached ??= schema.parse(process.env);
  return cached;
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
