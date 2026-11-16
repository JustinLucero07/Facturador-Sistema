import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { withContext } from '@vektra/db';
import {
  authorizeStep,
  buildTransport,
  CERT_ALERT_DAYS,
  certificateStatus,
  EInvoiceError,
  emailDocument,
  enqueueSriJob,
  pendingDocuments,
  RetryLaterError,
  sendStep,
  SRI_QUEUE,
  SriJobData,
} from '@vektra/einvoice';
import { Job, Queue, UnrecoverableError } from 'bullmq';
import { WorkerPrisma } from './prisma';
import { workerEnv } from './env';

/**
 * Procesa la cola del SRI. Errores temporales (SRI caído, en proceso) → se relanzan para que BullMQ
 * reintente con espera exponencial. Errores definitivos → UnrecoverableError (no se reintenta).
 */
@Processor(SRI_QUEUE, { concurrency: 4 })
export class SriProcessor extends WorkerHost {
  private readonly logger = new Logger('SRI');

  constructor(
    private readonly prisma: WorkerPrisma,
    @InjectQueue(SRI_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async process(job: Job<SriJobData>): Promise<unknown> {
    try {
      switch (job.name) {
        case 'send':
          return await this.send(job.data);
        case 'authorize':
          return await this.authorize(job.data);
        case 'email':
          return await emailDocument(this.prisma.client, job.data.tenantId, job.data.documentId, { masterKey: workerEnv().MASTER_KEY, overrideEmail: job.data.email });
        case 'sweep':
          return await this.sweep();
        case 'cert-alerts':
          return await this.certAlerts();
        default:
          throw new UnrecoverableError(`Trabajo desconocido: ${job.name}`);
      }
    } catch (e) {
      if (e instanceof RetryLaterError) {
        this.logger.warn(`${job.name} ${job.data.documentId ?? ''}: ${e.message} (intento ${job.attemptsMade + 1})`);
        throw e;
      }
      if (e instanceof EInvoiceError) throw new UnrecoverableError(e.message);
      throw e;
    }
  }

  private async send(data: SriJobData) {
    const next = await sendStep({ prisma: this.prisma.client }, data.tenantId, data.documentId);
    if (next.kind === 'authorize') await enqueueSriJob(this.queue, 'authorize', data, { delayMs: next.delayMs, force: true });
    return next.kind;
  }

  private async authorize(data: SriJobData) {
    const next = await authorizeStep({ prisma: this.prisma.client }, data.tenantId, data.documentId);
    if (next.kind === 'email') await enqueueSriJob(this.queue, 'email', data);
    this.logger.log(`Autorización ${data.documentId}: ${next.kind === 'none' ? 'finalizada' : next.kind}`);
    return next.kind;
  }

  /** Reencola comprobantes pendientes que quedaron fuera de la cola (reinicio, Redis vaciado…). */
  private async sweep() {
    const tenants = await this.prisma.client.tenant.findMany({ where: { status: 'ACTIVE' }, select: { id: true } });
    const olderThan = new Date(Date.now() - 2 * 60_000);
    let queued = 0;
    for (const t of tenants) {
      for (const d of await pendingDocuments(this.prisma.client, t.id, olderThan)) {
        const name = d.status === 'RECEIVED' ? 'authorize' : 'send';
        if (await enqueueSriJob(this.queue, name, { tenantId: t.id, documentId: d.documentId })) queued++;
      }
    }
    if (queued) this.logger.log(`Barrido: ${queued} comprobante(s) reencolados`);
    return queued;
  }

  /** Avisa por correo a los administradores 30, 15 y 5 días antes de que caduque la firma. */
  private async certAlerts() {
    const tenants = await this.prisma.client.tenant.findMany({ where: { status: 'ACTIVE' } });
    for (const t of tenants) {
      await withContext(this.prisma.client, { tenantId: t.id }, async (tx) => {
        const cert = await tx.certificate.findFirst({ where: { active: true }, orderBy: { createdAt: 'desc' } });
        if (!cert) return;
        const status = certificateStatus(cert);
        if (status.daysLeft === null) return;
        const sent = (cert.alertsSent as number[]) ?? [];
        const threshold = CERT_ALERT_DAYS.find((d) => status.daysLeft! <= d && !sent.includes(d));
        if (threshold === undefined) return;

        const mail = await tx.mailConfig.findUnique({ where: { tenantId: t.id } });
        const admins = await tx.membership.findMany({
          where: { active: true, roles: { some: { role: { systemCode: 'ADMIN' } } } },
          include: { user: true },
        });
        const to = admins.filter((m) => m.user.active).map((m) => m.user.email);
        if (mail?.enabled && to.length) {
          await buildTransport(mail, workerEnv().MASTER_KEY).sendMail({
            from: { name: mail.fromName, address: mail.fromEmail },
            to,
            subject: `⚠ Su firma electrónica caduca en ${status.daysLeft} días — ${t.tradeName ?? t.legalName}`,
            text: `${status.message}\n\nTitular: ${cert.holderName}\nVálida hasta: ${cert.validTo.toLocaleDateString('es-EC', { timeZone: 'America/Guayaquil' })}\n\nCuando tenga la nueva firma, cárguela en Vektra POS → Facturación electrónica → Firma electrónica.`,
          });
        }
        await tx.certificate.update({ where: { id: cert.id }, data: { alertsSent: [...sent, ...CERT_ALERT_DAYS.filter((d) => status.daysLeft! <= d)] } });
        this.logger.warn(`Firma de ${t.ruc} caduca en ${status.daysLeft} días (aviso ${threshold} d; correo: ${mail?.enabled && to.length ? 'sí' : 'sin SMTP'})`);
      });
    }
  }
}

@Injectable()
export class SriScheduler implements OnApplicationBootstrap {
  constructor(@InjectQueue(SRI_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap() {
    await this.queue.upsertJobScheduler('sweep', { every: 5 * 60_000 }, { name: 'sweep', opts: { removeOnComplete: 20, removeOnFail: 50 } });
    // Avisos de firma: todos los días a las 08:00 de Ecuador
    await this.queue.upsertJobScheduler('cert-alerts', { pattern: '0 8 * * *', tz: 'America/Guayaquil' }, { name: 'cert-alerts', opts: { removeOnComplete: 20, removeOnFail: 50 } });
    await this.queue.add('cert-alerts', {}, { removeOnComplete: true });
  }
}
