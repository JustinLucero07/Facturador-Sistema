import { config } from 'dotenv';
import { join } from 'node:path';

config({ path: join(process.cwd(), '.env'), quiet: true });
process.env['TZ'] ??= 'America/Guayaquil';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app/app.module';
import { hubEnv } from './app/core';

async function bootstrap() {
  const env = hubEnv();
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] });
  app.setGlobalPrefix('api');
  app.use(helmet());
  app.enableCors({ origin: env.HUB_WEB_ORIGIN.split(','), credentials: false });
  (app.getHttpAdapter().getInstance() as { set(k: string, v: unknown): void }).set('trust proxy', 'loopback, uniquelocal');
  app.enableShutdownHooks();
  await app.listen(env.HUB_PORT);
  Logger.log(`Vektra Hub escuchando en http://localhost:${env.HUB_PORT}/api`, 'Bootstrap');
}

bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});
