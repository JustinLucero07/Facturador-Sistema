import { InjectQueue } from '@nestjs/bullmq';
import { ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { encryptSecret, Prisma } from '@vektra/db';
import {
  activeCertificate,
  certificateStatus,
  EInvoiceError,
  enqueueSriJob,
  issueInvoice,
  issueCreditNote,
  issueWithholding,
  withholdingDraft,
  creditableInvoice,
  loadSriSettings,
  renderRide,
  retryTarget,
  SRI_QUEUE,
  storeCertificate,
  buildTransport,
} from '@vektra/einvoice';
import {
  EDocDetail,
  EDocListItem,
  EDocStatusCode,
  EInvoiceConfig,
  IssueInvoiceParsed,
  CreditNoteParsed,
  WithholdingParsed,
  WithholdingDraft,
  CreditableInvoice,
  MailConfigRequest,
  MailConfigView,
  Paginated,
  SriMessageView,
} from '@vektra/shared-contracts';
import { explainMessages, SriMessage } from '@vektra/sri-core';
import type { Queue } from 'bullmq';
import { AuditService } from '../audit/audit.service';
import { getEnv } from '../config/env';
import { PrismaService } from '../common/prisma.service';
import { currentContext } from '../common/request-context';

const views = (messages: unknown): SriMessageView[] =>
  explainMessages((messages as SriMessage[]) ?? []).map((m) => ({
    identifier: m.identifier,
    title: m.title,
    hint: m.hint,
    message: m.message,
    additionalInfo: m.additionalInfo,
    isError: m.isError,
  }));

function asUnprocessable(e: unknown): never {
  if (e instanceof EInvoiceError) throw new UnprocessableEntityException({ message: e.message, details: e.details });
  throw e;
}

const number = (est: string, pt: string, seq: bigint) => `${est}-${pt}-${seq.toString().padStart(9, '0')}`;

@Injectable()
export class EInvoiceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @InjectQueue(SRI_QUEUE) private readonly queue: Queue,
  ) {}

  private ctx() {
    const c = currentContext();
    return { tenantId: c.tenantId as string, userId: c.userId ?? null };
  }

  // ───────── Configuración para el formulario de factura ─────────

  async config(): Promise<EInvoiceConfig> {
    const { tenantId } = this.ctx();
    const db = this.prisma.client;
    const settings = await loadSriSettings(db);
    const [rates, payments, idTypes, tenant] = await Promise.all([
      db.taxRate.findMany({ where: { active: true }, orderBy: [{ sortOrder: 'asc' }] }),
      db.sriCatalog.findMany({ where: { catalog: 'payment_method', active: true }, orderBy: { sortOrder: 'asc' } }),
      db.sriCatalog.findMany({ where: { catalog: 'id_type', active: true }, orderBy: { sortOrder: 'asc' } }),
      db.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
    ]);
    const { points, cert } = await this.prisma.tx(async (tx) => ({
      points: await tx.emissionPoint.findMany({ where: { active: true, kind: 'WEB', establishment: { active: true } }, include: { establishment: true }, orderBy: [{ establishment: { code: 'asc' } }, { code: 'asc' }] }),
      cert: await activeCertificate(tx),
    }));
    return {
      taxRates: rates.map((r) => ({
        id: r.id,
        taxCode: r.taxCode,
        percentageCode: r.percentageCode,
        name: r.name,
        label: r.label,
        rate: r.rate.toFixed(2),
        validFrom: r.validFrom?.toISOString().slice(0, 10) ?? null,
        validTo: r.validTo?.toISOString().slice(0, 10) ?? null,
        active: r.active,
        sortOrder: r.sortOrder,
      })),
      paymentMethods: payments.map((p) => ({ code: p.code, description: p.description })),
      idTypes: idTypes.map((p) => ({ code: p.code, description: p.description })),
      finalConsumer: settings.finalConsumer,
      posPaymentMethods: settings.paymentMethods,
      emissionPoints: points.map((p) => ({ id: p.id, establishmentId: p.establishmentId, label: `${p.establishment.code}-${p.code} · ${p.name} (${p.establishment.name})` })),
      environment: tenant.environment,
      certificate: certificateStatus(cert),
    };
  }

  // ───────── Emisión ─────────

  async issue(input: IssueInvoiceParsed) {
    const ctx = this.ctx();
    if (input.lines.some((l) => l.discount && Number(l.discount) > 0) && !currentContext().permissions?.has('sales.discount')) {
      throw new ForbiddenException('No tiene permiso para aplicar descuentos');
    }
    const result = await issueInvoice(this.prisma.client, { ...ctx, masterKey: getEnv().MASTER_KEY }, input).catch(asUnprocessable);
    await this.audit.recordStandalone(ctx.tenantId, ctx.userId, {
      action: 'create',
      entity: 'invoice',
      entityId: result.documentId,
      after: { number: result.number, total: result.total, accessKey: result.accessKey, buyer: input.buyer.id },
    });
    await enqueueSriJob(this.queue, 'send', { tenantId: ctx.tenantId, documentId: result.documentId });
    return result;
  }

  // ───────── Consulta ─────────

  async list(q: { status?: Exclude<EDocStatusCode, 'PENDING_SYNC' | 'REJECTED_SYNC'>; search?: string; page: number; pageSize: number }): Promise<Paginated<EDocListItem>> {
    const where: Prisma.ElectronicDocumentWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.search
        ? {
            OR: [
              { accessKey: { contains: q.search } },
              { document: { buyerName: { contains: q.search, mode: 'insensitive' } } },
              { document: { buyerId: { contains: q.search } } },
            ],
          }
        : {}),
    };
    const [total, rows] = await this.prisma.tx((tx) =>
      Promise.all([
        tx.electronicDocument.count({ where }),
        tx.electronicDocument.findMany({
          where,
          include: { document: { include: { establishment: true, emissionPoint: true } } },
          orderBy: { createdAt: 'desc' },
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
        }),
      ]),
    );
    return { total, page: q.page, pageSize: q.pageSize, items: rows.map((r) => this.toListItem(r)) };
  }

  private toListItem(r: Prisma.ElectronicDocumentGetPayload<{ include: { document: { include: { establishment: true; emissionPoint: true } } } }>): EDocListItem {
    const d = r.document;
    return {
      id: r.documentId,
      docType: r.docType,
      number: number(d.establishment.code, d.emissionPoint.code, d.sequential),
      issueDate: d.issueDate.toISOString().slice(0, 10),
      buyerName: d.buyerName,
      buyerId: d.buyerId,
      total: d.total.toFixed(2),
      status: r.status,
      accessKey: r.accessKey,
      environment: r.environment,
      emailStatus: r.emailStatus,
      attempts: r.attempts,
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  async detail(documentId: string): Promise<EDocDetail> {
    const data = await this.prisma.tx(async (tx) => {
      const edoc = await tx.electronicDocument.findUnique({
        where: { documentId },
        include: {
          document: {
            include: {
              establishment: true,
              emissionPoint: true,
              lines: { include: { taxes: true }, orderBy: { lineNo: 'asc' } },
              payments: true,
              relatedDocument: { include: { establishment: true, emissionPoint: true } },
              creditNotes: { include: { establishment: true, emissionPoint: true, electronic: true }, orderBy: { createdAt: 'asc' } },
              withholdings: { orderBy: { lineNo: 'asc' } },
            },
          },
          events: { orderBy: { at: 'asc' } },
        },
      });
      return edoc;
    });
    if (!data) throw new NotFoundException('Comprobante no encontrado');
    const [rates, payments] = await Promise.all([
      this.prisma.client.taxRate.findMany({ where: { taxCode: '2' } }),
      this.prisma.client.sriCatalog.findMany({ where: { catalog: 'payment_method' } }),
    ]);
    const rateLabel = (code: string) => rates.find((r) => r.percentageCode === code)?.label ?? code;
    const d = data.document;
    // En la retención (07) taxSummary guarda datos del sustento, no grupos de IVA.
    const summary = Array.isArray(d.taxSummary) ? (d.taxSummary as { percentageCode: string; base: string; amount: string }[]) : [];
    return {
      ...this.toListItem(data),
      buyerEmail: d.buyerEmail,
      subtotal: d.subtotal.toFixed(2),
      totalTax: d.totalTax.toFixed(2),
      authorizationNumber: data.authorizationNumber,
      authorizedAt: data.authorizedAt?.toISOString() ?? null,
      messages: views(data.lastMessages),
      emailError: data.emailError,
      lines: d.lines.map((l) => ({
        description: l.description,
        quantity: l.quantity.toString(),
        unitPrice: l.unitPrice.toString(),
        discount: l.discount.toFixed(2),
        subtotal: l.subtotal.toFixed(2),
        taxLabel: l.taxes.map((t) => `IVA ${rateLabel(t.percentageCode)}`).join(', '),
      })),
      taxSummary: summary.map((g) => ({ label: rateLabel(g.percentageCode), base: g.base, amount: g.amount })),
      payments: d.payments.map((p) => ({ label: payments.find((x) => x.code === p.sriCode)?.description ?? p.sriCode, amount: p.amount.toFixed(2) })),
      events: data.events.map((e) => ({ at: e.at.toISOString(), from: e.fromStatus, to: e.toStatus, note: e.note, messages: views(e.messages) })),
      related: d.relatedDocument
        ? { id: d.relatedDocument.id, number: `${d.relatedDocument.establishment.code}-${d.relatedDocument.emissionPoint.code}-${d.relatedDocument.sequential.toString().padStart(9, '0')}` }
        : null,
      reason: d.reason,
      withholdings: d.withholdings.map((w) => ({
        tax: w.tax,
        code: w.code,
        description: w.description,
        base: w.base.toFixed(2),
        percentage: w.percentage.toString(),
        amount: w.amount.toFixed(2),
      })),
      purchase: d.purchaseId ? await this.purchaseRef(d.purchaseId) : null,
      creditNotes: d.creditNotes.map((n) => ({
        id: n.id,
        number: `${n.establishment.code}-${n.emissionPoint.code}-${n.sequential.toString().padStart(9, '0')}`,
        total: n.total.toFixed(2),
        status: (n.electronic?.status ?? 'DRAFT') as EDocStatusCode,
      })),
    };
  }

  private async purchaseRef(id: string): Promise<{ id: string; number: string } | null> {
    const p = await this.prisma.tx((tx) => tx.purchase.findFirst({ where: { id }, select: { id: true, number: true } }));
    return p ?? null;
  }

  // ───────── Comprobantes de retención ─────────

  withholdingDraft(purchaseId: string): Promise<WithholdingDraft> {
    return withholdingDraft(this.prisma.client, this.ctx().tenantId, purchaseId).catch(asUnprocessable);
  }

  async issueWithholding(input: WithholdingParsed) {
    const ctx = this.ctx();
    const result = await issueWithholding(this.prisma.client, { ...ctx, masterKey: getEnv().MASTER_KEY }, input).catch(asUnprocessable);
    await this.audit.recordStandalone(ctx.tenantId, ctx.userId, {
      action: 'create',
      entity: 'withholding',
      entityId: result.documentId,
      after: { number: result.number, total: result.total, purchaseId: input.purchaseId, items: input.items.length },
    });
    await enqueueSriJob(this.queue, 'send', { tenantId: ctx.tenantId, documentId: result.documentId });
    return result;
  }

  // ───────── Notas de crédito ─────────

  /** Busca una factura por número (001-001-000000123, también sin ceros) o por clave de acceso. */
  async findInvoice(q: string): Promise<{ id: string }> {
    const term = q.trim();
    const where = /^\d{49}$/.test(term)
      ? { electronic: { accessKey: term } }
      : (() => {
          const m = /^(\d{1,3})-(\d{1,3})-(\d{1,9})$/.exec(term);
          if (!m) throw new UnprocessableEntityException('Escriba el número de factura (ej. 001-001-000000123) o escanee la clave de acceso del ticket');
          return {
            establishment: { code: m[1].padStart(3, '0') },
            emissionPoint: { code: m[2].padStart(3, '0') },
            sequential: BigInt(m[3]),
          };
        })();
    const doc = await this.prisma.tx((tx) => tx.document.findFirst({ where: { ...where, docType: '01' }, select: { id: true } }));
    if (!doc) throw new NotFoundException('No se encontró esa factura');
    return doc;
  }

  creditable(invoiceId: string): Promise<CreditableInvoice> {
    return creditableInvoice(this.prisma.client, this.ctx().tenantId, invoiceId).catch(asUnprocessable);
  }

  async issueCreditNote(input: CreditNoteParsed) {
    const ctx = this.ctx();
    const result = await issueCreditNote(this.prisma.client, { ...ctx, masterKey: getEnv().MASTER_KEY }, input).catch(asUnprocessable);
    await this.audit.recordStandalone(ctx.tenantId, ctx.userId, {
      action: 'create',
      entity: 'credit_note',
      entityId: result.documentId,
      after: { number: result.number, total: result.total, invoiceId: input.invoiceId, reason: input.reason, refund: input.refund.method },
    });
    await enqueueSriJob(this.queue, 'send', { tenantId: ctx.tenantId, documentId: result.documentId });
    return result;
  }

  async xml(documentId: string): Promise<{ xml: string; fileName: string }> {
    const edoc = await this.prisma.tx((tx) => tx.electronicDocument.findUnique({ where: { documentId } }));
    if (!edoc) throw new NotFoundException('Comprobante no encontrado');
    const xml = edoc.authorizedXml ?? edoc.signedXml;
    if (!xml) throw new NotFoundException('El comprobante no tiene XML');
    return { xml, fileName: `${edoc.accessKey}${edoc.authorizedXml ? '' : '-firmado'}.xml` };
  }

  ride(documentId: string) {
    return renderRide(this.prisma.client, this.ctx().tenantId, documentId).catch(asUnprocessable);
  }

  async retry(documentId: string): Promise<{ queued: string | null }> {
    const { tenantId, userId } = this.ctx();
    const target = await retryTarget(this.prisma.client, tenantId, documentId);
    if (!target) throw new UnprocessableEntityException('Este comprobante no necesita reenviarse');
    await enqueueSriJob(this.queue, target, { tenantId, documentId }, { force: true });
    await this.audit.recordStandalone(tenantId, userId, { action: 'einvoice.retry', entity: 'invoice', entityId: documentId, after: { target } });
    return { queued: target };
  }

  async resendEmail(documentId: string, email?: string): Promise<void> {
    const { tenantId, userId } = this.ctx();
    const edoc = await this.prisma.tx((tx) => tx.electronicDocument.findUnique({ where: { documentId }, include: { document: true } }));
    if (!edoc) throw new NotFoundException('Comprobante no encontrado');
    // El cajero puede enviar por correo las facturas que él emitió (botón "Correo" de la caja).
    const perms = currentContext().permissions;
    if (!perms?.has('einvoice.resend') && !(perms?.has('sales.create') && edoc.document.createdBy === userId)) {
      throw new ForbiddenException('No tiene permiso para reenviar este comprobante');
    }
    if (edoc.status === 'NOT_AUTHORIZED') throw new UnprocessableEntityException('El SRI no autorizó este comprobante: no se puede enviar por correo');
    if (edoc.status !== 'AUTHORIZED') {
      // Aún en proceso: se guarda el destino y el worker lo envía apenas el SRI autorice.
      await this.prisma.tx(async (tx) => {
        if (email) await tx.document.update({ where: { id: documentId }, data: { buyerEmail: email } });
        await tx.electronicDocument.update({ where: { documentId }, data: { emailStatus: 'PENDING', emailError: null } });
      });
      await this.audit.recordStandalone(tenantId, userId, { action: 'einvoice.email', entity: 'invoice', entityId: documentId, after: { email: email ?? 'cliente', deferred: true } });
      return;
    }
    await this.prisma.tx((tx) => tx.electronicDocument.update({ where: { documentId }, data: { emailStatus: 'PENDING', emailError: null } }));
    await enqueueSriJob(this.queue, 'email', { tenantId, documentId, email }, { force: true });
    await this.audit.recordStandalone(tenantId, userId, { action: 'einvoice.email', entity: 'invoice', entityId: documentId, after: { email: email ?? 'cliente' } });
  }

  // ───────── Firma electrónica ─────────

  async certificate() {
    return certificateStatus(await this.prisma.tx((tx) => activeCertificate(tx)));
  }

  async uploadCertificate(p12: Buffer, password: string) {
    const { tenantId, userId } = this.ctx();
    const cert = await this.prisma
      .tx(async (tx) => {
        const c = await storeCertificate(tx, tenantId, userId, p12, password, getEnv().MASTER_KEY);
        await this.audit.record(tx, { action: 'certificate.uploaded', entity: 'certificate', entityId: c.id, after: { holder: c.holderName, validTo: c.validTo } });
        return c;
      })
      .catch(asUnprocessable);
    return certificateStatus(cert);
  }

  // ───────── Correo SMTP de la empresa ─────────

  async mailConfig(): Promise<MailConfigView | null> {
    const cfg = await this.prisma.tx((tx) => tx.mailConfig.findUnique({ where: { tenantId: this.ctx().tenantId } }));
    if (!cfg) return null;
    return {
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      username: cfg.username,
      hasPassword: !!cfg.passwordEnc,
      fromName: cfg.fromName,
      fromEmail: cfg.fromEmail,
      replyTo: cfg.replyTo,
      enabled: cfg.enabled,
    };
  }

  async saveMailConfig(input: MailConfigRequest): Promise<void> {
    const { tenantId } = this.ctx();
    await this.prisma.tx(async (tx) => {
      const existing = await tx.mailConfig.findUnique({ where: { tenantId } });
      const passwordEnc = input.password ? encryptSecret(input.password, getEnv().MASTER_KEY) : (existing?.passwordEnc ?? null);
      const data = {
        host: input.host,
        port: input.port,
        secure: input.secure,
        username: input.username || null,
        passwordEnc,
        fromName: input.fromName,
        fromEmail: input.fromEmail,
        replyTo: input.replyTo || null,
        enabled: input.enabled ?? true,
      };
      await tx.mailConfig.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data });
      await this.audit.record(tx, { action: 'update', entity: 'mail_config', entityId: tenantId, after: { ...data, passwordEnc: undefined } });
    });
  }

  async testMail(to: string): Promise<void> {
    const cfg = await this.prisma.tx((tx) => tx.mailConfig.findUnique({ where: { tenantId: this.ctx().tenantId } }));
    if (!cfg) throw new UnprocessableEntityException('Primero guarde la configuración de correo');
    try {
      await buildTransport(cfg, getEnv().MASTER_KEY).sendMail({
        from: { name: cfg.fromName, address: cfg.fromEmail },
        to,
        subject: 'Prueba de correo — Vektra POS',
        text: 'Si recibe este mensaje, el correo de su empresa está bien configurado para enviar facturas electrónicas.',
      });
    } catch (e) {
      throw new UnprocessableEntityException(`No se pudo enviar el correo de prueba: ${(e as Error).message}`);
    }
  }
}
