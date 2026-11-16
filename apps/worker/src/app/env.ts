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
  MASTER_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'MASTER_KEY debe ser 32 bytes en base64'),
});
export type WorkerEnv = z.infer<typeof schema>;

let cached: WorkerEnv | null = null;
export function workerEnv(): WorkerEnv {
  cached ??= schema.parse(process.env);
  return cached;
}

export { redisConnection } from '@vektra/einvoice';
