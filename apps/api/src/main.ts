import { config } from 'dotenv';
import { join } from 'node:path';

// En desarrollo se lee el .env de la raíz del monorepo; en Docker las variables vienen del entorno.
config({ path: join(process.cwd(), '.env'), quiet: true });
process.env['TZ'] ??= 'America/Guayaquil';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { configureApp } from './app/bootstrap';
import { getEnv } from './app/config/env';

async function bootstrap() {
  const env = getEnv();
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] });
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(env.API_PORT);
  Logger.log(`API Vektra POS escuchando en http://localhost:${env.API_PORT}/api`, 'Bootstrap');
}

bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});
