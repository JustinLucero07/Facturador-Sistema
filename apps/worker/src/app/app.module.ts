import { InjectQueue, BullModule, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, Module, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { createPrismaClient, PrismaClient } from '@vektra/db';
import type { Job, Queue } from 'bullmq';
import { redisConnection, workerEnv } from './env';
import { checkLicenseWithHub } from './license-check';

export const SYSTEM_QUEUE = 'system';

@Injectable()
export class WorkerPrisma implements OnModuleDestroy {
  readonly client: PrismaClient = createPrismaClient(workerEnv().DATABASE_URL);
  async onModuleDestroy() {
    await this.client.$disconnect();
  }
}

/** Tareas del sistema. En la Fase 1 se agregan las colas del SRI (envío/autorización) y correo. */
@Processor(SYSTEM_QUEUE)
export class SystemProcessor extends WorkerHost {
  constructor(private readonly prisma: WorkerPrisma) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case 'license-check':
        return checkLicenseWithHub(this.prisma.client, workerEnv());
      default:
        throw new Error(`Tarea desconocida: ${job.name}`);
    }
  }
}

@Injectable()
export class Scheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(Scheduler.name);
  constructor(@InjectQueue(SYSTEM_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap() {
    const minutes = workerEnv().LICENSE_CHECK_MINUTES;
    await this.queue.upsertJobScheduler('license-check', { every: minutes * 60_000 }, { name: 'license-check', opts: { removeOnComplete: 50, removeOnFail: 100 } });
    // Validar siempre al arrancar: si el scheduler ya existía en Redis (reinicio), su próxima
    // ejecución puede estar hasta 1 h en el futuro.
    await this.queue.add('license-check', {}, { removeOnComplete: 50, removeOnFail: 100 });
    this.logger.log(`Validación de licencia programada cada ${minutes} min`);
  }
}

@Module({
  imports: [
    BullModule.forRoot({ connection: redisConnection(workerEnv().REDIS_URL) }),
    BullModule.registerQueue({ name: SYSTEM_QUEUE }),
  ],
  providers: [WorkerPrisma, SystemProcessor, Scheduler],
})
export class AppModule {}
