import { config } from 'dotenv';
import { join } from 'node:path';

config({ path: join(process.cwd(), '.env'), quiet: true });
process.env['TZ'] ??= 'America/Guayaquil';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'warn', 'error'] });
  app.enableShutdownHooks();
  Logger.log('Worker Vektra POS iniciado', 'Bootstrap');
}

bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});
