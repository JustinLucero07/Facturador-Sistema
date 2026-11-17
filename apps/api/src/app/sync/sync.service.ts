import { InjectQueue } from '@nestjs/bullmq';
import { ConflictException, HttpException, Injectable, Logger } from '@nestjs/common';
import { claimSequential, Prisma, Tx, uuidv7 } from '@vektra/db';
import { activeCertificate, certificateStatus, EInvoiceError, enqueueSriJob, issueCreditNote, issueInvoice, loadSriSettings, SRI_QUEUE } from '@vektra/einvoice';
import { defaultWarehouseId } from '@vektra/inventory';
import type { SyncOpResult, SyncPullResponse, SyncPushParsed, SyncPushResponse } from '@vektra/shared-contracts';
import { validateCedula, validateRuc } from '@vektra/shared-domain';
import { CalculationError, computeInvoice } from '@vektra/sri-core';
import type { Queue } from 'bullmq';
import { AuditService } from '../audit/audit.service';
import { createQuickProduct } from '../catalog/quick-product';
import { PrismaService } from '../common/prisma.service';
import { currentContext } from '../common/request-context';
import { getEnv } from '../config/env';
import type { DeviceRow } from '../devices/devices.service';
import { EInvoiceService } from '../einvoice/einvoice.service';
import { LicenseService } from '../license/license.service';

type PushOp = SyncPushParsed['ops'][number];

/** Error de datos de una operación: se informa a la caja y no se reintenta. */
class OpRejected extends Error {}

/** Permiso que debe tener (en el servidor) el usuario que hizo la operación en la caja. */
const OP_PERMISSION: Record<PushOp['type'], string> = {
  'party.upsert': 'customers.manage',
  'product.create': 'catalog.manage',
  'cash.open': 'cash.operate',
  'cash.movement': 'cash.operate',
  'cash.close': 'cash.operate',
  'invoice.issue': 'sales.create',
  'credit_note.issue': 'sales.void',
  'quote.create': 'sales.quote',
  'document.email': 'sales.create',
};

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly license: LicenseService,
    private readonly einvoice: EInvoiceService,
    @InjectQueue(SRI_QUEUE) private readonly queue: Queue,
  ) {}

  // ───────────────────────── Pull ─────────────────────────

  async pull(device: DeviceRow, since: string | null): Promise<SyncPullResponse> {
    const serverTime = new Date();
    // Margen de 5 s: transacciones que confirmaron justo después del corte anterior.
    const sinceDate = since && !Number.isNaN(Date.parse(since)) ? new Date(Date.parse(since) - 5000) : null;
    const changed = sinceDate ? { updatedAt: { gt: sinceDate } } : {};
    const db = this.prisma.client;
    const settings = await loadSriSettings(db);
    const [tenant, rates, idTypes, license] = await Promise.all([
      db.tenant.findUniqueOrThrow({ where: { id: device.tenant_id } }),
      db.taxRate.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } }),
      db.sriCatalog.findMany({ where: { catalog: 'id_type', active: true }, orderBy: { sortOrder: 'asc' } }),
      this.license.status(device.tenant_id),
    ]);

    const data = await this.prisma.as({ tenantId: device.tenant_id, userId: null }, async (tx) => {
      const dev = await tx.device.findUniqueOrThrow({ where: { id: device.id } });
      const ep = await tx.emissionPoint.findUniqueOrThrow({ where: { id: device.emission_point_id }, include: { establishment: true } });
      const warehouseId = await defaultWarehouseId(tx, ep.establishmentId).catch(() => null);
      const [sequences, units, priceLists, memberships, products, parties, stock, docs, cert] = await Promise.all([
        tx.sequenceCounter.findMany({ where: { emissionPointId: ep.id } }),
        tx.unit.findMany({ where: { active: true } }),
        tx.priceList.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } }),
        tx.membership.findMany({
          where: { tenantId: device.tenant_id },
          include: { user: true, roles: { include: { role: { include: { permissions: true } } } } },
        }),
        tx.product.findMany({ where: changed, include: { units: true, barcodes: true, prices: true }, orderBy: { updatedAt: 'asc' } }),
        tx.party.findMany({ where: { ...changed, isCustomer: true } }),
        warehouseId ? tx.stock.findMany({ where: { warehouseId, ...changed } }) : Promise.resolve([]),
        tx.electronicDocument.findMany({
          where: { document: { deviceId: device.id }, ...(sinceDate ? { updatedAt: { gt: sinceDate } } : { status: { not: 'AUTHORIZED' } }) },
          select: { documentId: true, status: true, authorizationNumber: true, authorizedAt: true, lastMessages: true },
          take: 2000,
        }),
        activeCertificate(tx),
      ]);
      await tx.device.update({ where: { id: device.id }, data: { lastSeenAt: serverTime } });
      return { dev, ep, warehouseId, sequences, units, priceLists, memberships, products, parties, stock, docs, cert };
    });

    const branding = (tenant.branding ?? {}) as { logoBase64?: string };
    const tenantSettings = (tenant.settings ?? {}) as { allowNegativeStock?: boolean };
    return {
      serverTime: serverTime.toISOString(),
      cursor: serverTime.toISOString(),
      full: !sinceDate,
      device: { id: data.dev.id, name: data.dev.name, status: data.dev.status },
      company: {
        ruc: tenant.ruc,
        legalName: tenant.legalName,
        tradeName: tenant.tradeName,
        mainAddress: tenant.mainAddress,
        keepsAccounting: tenant.keepsAccounting,
        specialTaxpayerNumber: tenant.specialTaxpayerNumber,
        withholdingAgentNumber: tenant.withholdingAgentNumber,
        rimpeLegend: settings.rimpeLegends[tenant.taxRegime] ?? null,
        logoBase64: branding.logoBase64 ?? null,
        environment: tenant.environment,
        allowNegativeStock: tenantSettings.allowNegativeStock ?? true,
      },
      emissionPoint: {
        id: data.ep.id,
        code: data.ep.code,
        name: data.ep.name,
        establishmentId: data.ep.establishmentId,
        establishmentCode: data.ep.establishment.code,
        establishmentName: data.ep.establishment.name,
        establishmentAddress: data.ep.establishment.address,
        warehouseId: data.warehouseId,
      },
      sequences: Object.fromEntries(data.sequences.map((s) => [s.docType, Number(s.nextValue)])),
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
      units: data.units.map((u) => ({ id: u.id, code: u.code, name: u.name, allowsDecimal: u.allowsDecimal })),
      priceLists: data.priceLists.map((p) => ({ id: p.id, code: p.code, name: p.name, isDefault: p.isDefault })),
      paymentMethods: settings.paymentMethods,
      finalConsumer: settings.finalConsumer,
      idTypes: idTypes.map((p) => ({ code: p.code, description: p.description })),
      certificate: certificateStatus(data.cert),
      license,
      maxOfflineHours: settings.desktopMaxOfflineHours,
      users: data.memberships.map((m) => {
        const permissions = new Set<string>();
        for (const mr of m.roles) for (const rp of mr.role.permissions) permissions.add(rp.permissionCode);
        return {
          id: m.user.id,
          email: m.user.email,
          fullName: m.user.fullName,
          passwordHash: m.user.passwordHash,
          active: m.active && m.user.active,
          permissions: [...permissions],
        };
      }),
      products: data.products.map((p) => ({
        id: p.id,
        code: p.code,
        name: p.name,
        auxCode: p.auxCode,
        unitId: p.unitId,
        taxRateId: p.taxRateId,
        isService: p.isService,
        active: p.active,
        units: p.units.map((u) => ({ id: u.id, unitId: u.unitId, factor: u.factor.toString(), isBase: u.isBase })),
        barcodes: p.barcodes.map((b) => ({ barcode: b.barcode, productUnitId: b.productUnitId })),
        prices: p.prices.map((x) => ({ priceListId: x.priceListId, productUnitId: x.productUnitId, price: x.price.toString() })),
        updatedAt: p.updatedAt.toISOString(),
      })),
      parties: data.parties.map((p) => ({
        id: p.id,
        idType: p.idType,
        identification: p.identification,
        name: p.name,
        tradeName: p.tradeName,
        email: p.email,
        phone: p.phone,
        address: p.address,
        isCustomer: p.isCustomer,
        priceListId: p.priceListId,
        creditLimit: p.creditLimit.toFixed(2),
        creditDays: p.creditDays,
        active: p.active,
        updatedAt: p.updatedAt.toISOString(),
      })),
      stock: data.stock.map((s) => ({ productId: s.productId, quantity: s.quantity.toString() })),
      documents: data.docs.map((d) => {
        const msgs = (Array.isArray(d.lastMessages) ? d.lastMessages : []) as { message?: string; additionalInfo?: string | null }[];
        const first = msgs[0];
        return {
          id: d.documentId,
          status: d.status,
          authorizationNumber: d.authorizationNumber,
          authorizedAt: iso(d.authorizedAt),
          message: first ? [first.message, first.additionalInfo].filter(Boolean).join(': ') : null,
        };
      }),
    };
  }

  // ───────────────────────── Push ─────────────────────────

  async push(device: DeviceRow, body: SyncPushParsed): Promise<SyncPushResponse> {
    const tenantId = device.tenant_id;
    const ctx = currentContext();
    const results: SyncOpResult[] = [];
    const perms = new Map<string, Set<string> | null>();

    for (const op of body.ops) {
      const prev = await this.prisma.as({ tenantId, userId: null }, (tx) => tx.syncOp.findUnique({ where: { id: op.opId } }));
      if (prev) {
        results.push({ opId: op.opId, status: prev.status === 'APPLIED' ? 'duplicate' : 'rejected', message: prev.message ?? undefined, data: (prev.result ?? undefined) as Record<string, unknown> | undefined });
        continue;
      }
      ctx.userId = op.userId;
      let result: SyncOpResult;
      try {
        if (!perms.has(op.userId)) perms.set(op.userId, await this.permissionsOf(tenantId, op.userId));
        const p = perms.get(op.userId);
        if (!p) throw new OpRejected('El usuario de la caja ya no tiene acceso a esta empresa');
        if (!p.has(OP_PERMISSION[op.type])) throw new OpRejected('El usuario de la caja no tiene permiso para esta operación');
        const data = await this.apply(device, op);
        result = { opId: op.opId, status: data === 'duplicate' ? 'duplicate' : 'applied', data: data === 'duplicate' ? undefined : data };
      } catch (e) {
        const message = rejectionMessage(e);
        if (message === null) throw e; // error transitorio (BD, red…): la caja reintentará el lote
        result = { opId: op.opId, status: 'rejected', message };
        this.logger.warn(`Caja ${device.id}: operación ${op.type} ${op.opId} rechazada: ${message}`);
      }
      await this.prisma.as({ tenantId, userId: op.userId }, (tx) =>
        tx.syncOp.create({
          data: {
            id: op.opId,
            tenantId,
            deviceId: device.id,
            type: op.type,
            status: result.status === 'rejected' ? 'REJECTED' : 'APPLIED',
            message: result.message ?? null,
            payload: op.payload as unknown as Prisma.InputJsonValue,
            result: (result.data ?? Prisma.DbNull) as Prisma.InputJsonValue,
            clientAt: new Date(op.clientAt),
          },
        }),
      );
      results.push(result);
    }
    ctx.userId = undefined;

    const now = new Date();
    await this.prisma.as({ tenantId, userId: null }, (tx) =>
      tx.device.update({
        where: { id: device.id },
        data: {
          lastSeenAt: now,
          lastSyncAt: now,
          pendingOps: Math.max(0, body.pending - results.length),
          failedOps: body.failed + results.filter((r) => r.status === 'rejected').length,
          ...(body.appVersion ? { appVersion: body.appVersion } : {}),
        },
      }),
    );
    return { serverTime: now.toISOString(), results };
  }

  private async permissionsOf(tenantId: string, userId: string): Promise<Set<string> | null> {
    const m = await this.prisma.as({ tenantId, userId }, (tx) =>
      tx.membership.findFirst({
        where: { tenantId, userId, active: true, user: { active: true } },
        include: { roles: { include: { role: { include: { permissions: true } } } } },
      }),
    );
    if (!m) return null;
    const s = new Set<string>();
    for (const mr of m.roles) for (const rp of mr.role.permissions) s.add(rp.permissionCode);
    return s;
  }

  private as<T>(device: DeviceRow, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.as({ tenantId: device.tenant_id, userId }, fn);
  }

  /** Aplica una operación. Devuelve datos para la caja o 'duplicate' si ya estaba aplicada. */
  private async apply(device: DeviceRow, op: PushOp): Promise<Record<string, unknown> | 'duplicate'> {
    const tenantId = device.tenant_id;
    switch (op.type) {
      case 'party.upsert': {
        const p = op.payload;
        const idError = p.idType === '05' ? validateCedula(p.identification) : p.idType === '04' ? validateRuc(p.identification) : { valid: true };
        if (!idError.valid) throw new OpRejected(`Identificación inválida: ${(idError as { error?: string }).error ?? ''}`);
        return this.as(device, op.userId, async (tx) => {
          const existing = await tx.party.findFirst({ where: { identification: p.identification } });
          if (existing) {
            // No se pisan datos comerciales (lista de precios, crédito): solo contacto que la caja conoce.
            await tx.party.update({
              where: { id: existing.id },
              data: { name: p.name, ...(p.email ? { email: p.email } : {}), ...(p.phone ? { phone: p.phone } : {}), ...(p.address ? { address: p.address } : {}), isCustomer: true },
            });
            return { id: existing.id, merged: existing.id !== p.id };
          }
          await tx.party.create({
            data: { id: p.id, tenantId, idType: p.idType, identification: p.identification, name: p.name, email: p.email ?? null, phone: p.phone ?? null, address: p.address ?? null, isCustomer: true },
          });
          await this.audit.record(tx, { action: 'create', entity: 'party', entityId: p.id, after: { identification: p.identification, name: p.name, origin: 'desktop' } });
          return { id: p.id };
        });
      }

      case 'product.create': {
        const p = op.payload;
        return this.as(device, op.userId, async (tx) => {
          let created: boolean;
          try {
            created = await createQuickProduct(tx, tenantId, p);
          } catch (e) {
            if (e instanceof ConflictException) {
              throw new OpRejected(`Ya existe otro producto con el código ${p.code}. Las ventas de la caja con este producto quedan como líneas libres (sin stock).`);
            }
            throw e;
          }
          if (!created) return 'duplicate';
          await this.audit.record(tx, { action: 'create', entity: 'product', entityId: p.id, after: { code: p.code, name: p.name, origin: 'desktop' } });
          return { id: p.id };
        });
      }

      case 'cash.open': {
        const p = op.payload;
        return this.as(device, op.userId, async (tx) => {
          if (await tx.cashSession.findFirst({ where: { id: p.id }, select: { id: true } })) return 'duplicate';
          const open = await tx.cashSession.findFirst({ where: { emissionPointId: device.emission_point_id, status: 'OPEN' } });
          if (open) {
            // La caja es la única dueña del punto: una sesión abierta que no conoce quedó huérfana
            // (p. ej. reinstalación). Se cierra sin arqueo para no bloquear las ventas.
            await tx.cashSession.update({ where: { id: open.id }, data: { status: 'CLOSED', closedAt: new Date(p.openedAt), notes: 'Cerrada automáticamente: la caja de escritorio abrió un nuevo turno' } });
          }
          await tx.cashSession.create({
            data: { id: p.id, tenantId, emissionPointId: device.emission_point_id, openedBy: op.userId, openedAt: new Date(p.openedAt), openingAmount: p.openingAmount },
          });
          await this.audit.record(tx, { action: 'cash.open', entity: 'cash_session', entityId: p.id, after: { openingAmount: p.openingAmount, origin: 'desktop' } });
          return { id: p.id };
        });
      }

      case 'cash.movement': {
        const p = op.payload;
        return this.as(device, op.userId, async (tx) => {
          if (await tx.cashMovement.findFirst({ where: { id: p.id }, select: { id: true } })) return 'duplicate';
          const s = await tx.cashSession.findFirst({ where: { id: p.sessionId, emissionPointId: device.emission_point_id } });
          if (!s) throw new OpRejected('La caja de este movimiento no existe en el servidor');
          await tx.cashMovement.create({ data: { id: p.id, tenantId, sessionId: s.id, type: p.type, amount: p.amount, reason: p.reason, createdBy: op.userId, at: new Date(p.at) } });
          await this.audit.record(tx, { action: `cash.${p.type === 'IN' ? 'income' : 'expense'}`, entity: 'cash_session', entityId: s.id, after: { amount: p.amount, reason: p.reason, origin: 'desktop' } });
          return { id: p.id };
        });
      }

      case 'cash.close': {
        const p = op.payload;
        return this.as(device, op.userId, async (tx) => {
          const s = await tx.cashSession.findFirst({ where: { id: p.sessionId, emissionPointId: device.emission_point_id } });
          if (!s) throw new OpRejected('La caja que se intenta cerrar no existe en el servidor');
          if (s.status === 'CLOSED') return 'duplicate';
          // El arqueo se hizo físicamente en la caja: se guarda tal como lo registró el cajero.
          await tx.cashSession.update({
            where: { id: s.id },
            data: {
              status: 'CLOSED',
              closedBy: op.userId,
              closedAt: new Date(p.closedAt),
              expected: p.expected,
              counted: p.counted,
              denominations: (p.denominations ?? Prisma.DbNull) as Prisma.InputJsonValue,
              difference: p.difference,
              notes: p.notes ?? null,
            },
          });
          await this.audit.record(tx, { action: 'cash.close', entity: 'cash_session', entityId: s.id, after: { expected: p.expected, counted: p.counted, difference: p.difference, origin: 'desktop' } });
          return { id: s.id };
        });
      }

      case 'invoice.issue': {
        const p = op.payload;
        const req = p.request;
        if (req.emissionPointId !== device.emission_point_id) throw new OpRejected('La factura no corresponde al punto de emisión de esta caja');
        const exists = await this.as(device, op.userId, (tx) => tx.document.findFirst({ where: { id: p.documentId }, select: { id: true } }));
        if (exists) return 'duplicate';
        // Productos creados en la caja que el servidor rechazó: la línea queda como línea libre.
        const ids = [...new Set(req.lines.map((l) => l.productId).filter((x): x is string => !!x))];
        const known = new Set(
          (await this.as(device, op.userId, (tx) => tx.product.findMany({ where: { id: { in: ids } }, select: { id: true } }))).map((x) => x.id),
        );
        const request = {
          ...req,
          lines: req.lines.map((l) => (l.productId && !known.has(l.productId) ? { ...l, productId: null, productUnitId: null } : l)),
        };
        const result = await issueInvoice(
          this.prisma.client,
          {
            tenantId,
            userId: op.userId,
            masterKey: getEnv().MASTER_KEY,
            offline: { documentId: p.documentId, deviceId: device.id, sequential: p.sequential, issuedAt: new Date(p.issuedAt), accessKey: p.accessKey },
          },
          request,
        );
        await this.audit.recordStandalone(tenantId, op.userId, {
          action: 'create',
          entity: 'invoice',
          entityId: result.documentId,
          after: { number: result.number, total: result.total, accessKey: result.accessKey, buyer: req.buyer.id, origin: 'desktop' },
        });
        await enqueueSriJob(this.queue, 'send', { tenantId, documentId: result.documentId });
        return { documentId: result.documentId, number: result.number, status: 'SIGNED' };
      }

      case 'credit_note.issue': {
        const p = op.payload;
        const req = p.request;
        if (req.emissionPointId !== device.emission_point_id) throw new OpRejected('La nota de crédito no corresponde al punto de emisión de esta caja');
        const found = await this.as(device, op.userId, async (tx) => ({
          exists: await tx.document.findFirst({ where: { id: p.documentId }, select: { id: true } }),
          lines: await tx.documentLine.findMany({ where: { documentId: req.invoiceId }, select: { id: true, lineNo: true } }),
        }));
        if (found.exists) return 'duplicate';
        if (!found.lines.length) throw new OpRejected('La factura de esta devolución no existe en el servidor');
        const lines = req.lines.map((l) => {
          const src = found.lines.find((x) => x.lineNo === l.lineNo);
          if (!src) throw new OpRejected(`La línea ${l.lineNo} no existe en la factura`);
          return { sourceLineId: src.id, quantity: l.quantity, restock: l.restock };
        });
        const result = await issueCreditNote(
          this.prisma.client,
          {
            tenantId,
            userId: op.userId,
            masterKey: getEnv().MASTER_KEY,
            offline: {
              documentId: p.documentId,
              deviceId: device.id,
              sequential: p.sequential,
              issuedAt: new Date(p.issuedAt),
              accessKey: p.accessKey,
              cashMovementId: p.cashMovementId ?? undefined,
            },
          },
          { ...req, buyer: req.buyer ?? null, lines },
        );
        await this.audit.recordStandalone(tenantId, op.userId, {
          action: 'create',
          entity: 'credit_note',
          entityId: result.documentId,
          after: { number: result.number, total: result.total, invoiceId: req.invoiceId, reason: req.reason, origin: 'desktop' },
        });
        await enqueueSriJob(this.queue, 'send', { tenantId, documentId: result.documentId });
        return { documentId: result.documentId, number: result.number, status: 'SIGNED' };
      }

      case 'quote.create': {
        const p = op.payload;
        const req = p.request;
        const rates = await this.prisma.client.taxRate.findMany({ where: { id: { in: req.lines.map((l) => l.taxRateId) } } });
        let total: string;
        try {
          total = computeInvoice(
            req.lines.map((l) => {
              const r = rates.find((x) => x.id === l.taxRateId);
              if (!r) throw new CalculationError('Tarifa no encontrada');
              return { description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, discount: l.discount, taxes: [{ taxCode: r.taxCode, percentageCode: r.percentageCode, rate: r.rate.toString() }] };
            }),
          ).totals.total;
        } catch (e) {
          throw new OpRejected((e as Error).message);
        }
        return this.as(device, op.userId, async (tx) => {
          if (await tx.quote.findFirst({ where: { id: p.id }, select: { id: true } })) return 'duplicate';
          const createdAt = new Date(p.createdAt);
          const validUntil = new Date(createdAt);
          validUntil.setUTCDate(validUntil.getUTCDate() + req.validDays);
          await claimSequential(tx, device.emission_point_id, 'PF', p.number);
          await tx.quote.create({
            data: {
              id: p.id,
              tenantId,
              emissionPointId: device.emission_point_id,
              number: p.number,
              buyerIdType: req.buyer.idType,
              buyerId: req.buyer.id,
              buyerName: req.buyer.name,
              buyerEmail: req.buyer.email ?? null,
              priceListId: req.priceListId ?? null,
              lines: req.lines as unknown as Prisma.InputJsonValue,
              total,
              validUntil,
              notes: req.notes ?? null,
              createdBy: op.userId,
              createdAt,
            },
          });
          return { id: p.id };
        });
      }

      case 'document.email': {
        await this.einvoice.resendEmail(op.payload.documentId, op.payload.email ?? undefined);
        return { documentId: op.payload.documentId };
      }
    }
  }
}

/** Mensaje para la caja si el error es de datos; null si es transitorio (reintentar). */
function rejectionMessage(e: unknown): string | null {
  if (e instanceof OpRejected || e instanceof EInvoiceError || e instanceof CalculationError) {
    const details = (e as { details?: string[] }).details;
    return details?.length ? `${e.message}: ${details.slice(0, 3).join('; ')}` : e.message;
  }
  if (e instanceof HttpException && e.getStatus() < 500) {
    const r = e.getResponse();
    return typeof r === 'string' ? r : ((r as { message?: string }).message ?? e.message);
  }
  if (e instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2003', 'P2025'].includes(e.code)) {
    return `Conflicto de datos en el servidor (${e.code})`;
  }
  return null;
}
