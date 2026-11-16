import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  API_PORT: z.coerce.number().default(3300),
  WEB_ORIGIN: z.string().default('http://localhost:4300'),
  /** URL pública del sistema (links de RIDE por WhatsApp). Por defecto, el primer WEB_ORIGIN. */
  PUBLIC_URL: z.string().default(''),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET debe tener al menos 32 caracteres'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().default(900),
  REFRESH_TTL_DAYS: z.coerce.number().default(7),
  MASTER_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'MASTER_KEY debe ser 32 bytes en base64'),
  AUTH_MAX_FAILED_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  AUTH_LOCK_MINUTES: z.coerce.number().int().min(1).default(15),
  INSTALLATION_ID: z.string().default(''),
  LICENSE_PUBLIC_KEY: z.string().default(''),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuración inválida (.env):\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Solo para pruebas. */
export function resetEnvCache(): void {
  cached = null;
}
