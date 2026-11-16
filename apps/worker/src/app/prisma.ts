import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { createPrismaClient, PrismaClient } from '@vektra/db';
import { workerEnv } from './env';

@Injectable()
export class WorkerPrisma implements OnModuleDestroy {
  readonly client: PrismaClient = createPrismaClient(workerEnv().DATABASE_URL);
  async onModuleDestroy() {
    await this.client.$disconnect();
  }
}
