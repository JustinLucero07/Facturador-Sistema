import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { getEnv } from './config/env';
import { runWithContext } from './common/request-context';

/** Configuración compartida entre main.ts y las pruebas e2e. */
export function configureApp(app: INestApplication): void {
  const env = getEnv();
  app.setGlobalPrefix('api');
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({ origin: env.WEB_ORIGIN.split(','), credentials: true });
  const http = app.getHttpAdapter().getInstance() as { set(key: string, value: unknown): void };
  // Detrás de nginx/caddy en la VPS: confiar en X-Forwarded-For del proxy local.
  http.set('trust proxy', 'loopback, uniquelocal');

  app.use((req: { ip?: string; headers: Record<string, string | string[] | undefined> }, _res: unknown, next: () => void) => {
    const ua = req.headers['user-agent'];
    runWithContext({ ip: req.ip ?? null, userAgent: typeof ua === 'string' ? ua : null }, next);
  });
}
