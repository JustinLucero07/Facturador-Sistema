import { ConflictException, Injectable, NotFoundException, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import { uuidv7 } from '@vektra/db';
import type { DeviceItem, DevicePairingCode, PairDeviceResponse, SyncOpItem } from '@vektra/shared-contracts';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../common/prisma.service';
import { currentContext } from '../common/request-context';
import { deviceLinkKey, publicBaseUrl } from '../pos/public-link';

export const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

/** Sin caracteres ambiguos (0/O, 1/I/L) para dictarlo por teléfono. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PAIRING_MINUTES = 30;

function newPairingCode(): string {
  let out = '';
  for (let i = 0; i < 10; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

export interface DeviceRow {
  id: string;
  tenant_id: string;
  emission_point_id: string;
  status: string;
  pairing_expires_at: Date | null;
}

@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Busca una caja por el hash de su token o de su código (sin conocer aún la empresa). */
  async lookup(by: { tokenHash?: string; codeHash?: string }): Promise<DeviceRow | null> {
    const rows = await this.prisma.client.$queryRaw<DeviceRow[]>`SELECT * FROM device_lookup(${by.tokenHash ?? null}, ${by.codeHash ?? null})`;
    return rows[0] ?? null;
  }

  async list(): Promise<DeviceItem[]> {
    const rows = await this.prisma.tx(async (tx) => {
      const devices = await tx.device.findMany({ orderBy: { createdAt: 'asc' }, include: { emissionPoint: { include: { establishment: true } } } });
      const pending = await tx.document.groupBy({
        by: ['deviceId'],
        where: { deviceId: { in: devices.map((d) => d.id) }, electronic: { status: { notIn: ['AUTHORIZED'] } } },
        _count: true,
      });
      return devices.map((d) => ({ d, unauthorized: pending.find((p) => p.deviceId === d.id)?._count ?? 0 }));
    });
    return rows.map(({ d, unauthorized }) => ({
      id: d.id,
      name: d.name,
      emissionPointId: d.emissionPointId,
      emissionPoint: `${d.emissionPoint.establishment.code}-${d.emissionPoint.code} · ${d.emissionPoint.name}`,
      status: d.status as DeviceItem['status'],
      appVersion: d.appVersion,
      lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
      lastSyncAt: d.lastSyncAt?.toISOString() ?? null,
      pendingOps: d.pendingOps,
      failedOps: d.failedOps,
      unauthorized,
      pairingExpiresAt: d.status === 'pending' && d.pairingExpiresAt && d.pairingExpiresAt > new Date() ? d.pairingExpiresAt.toISOString() : null,
      createdAt: d.createdAt.toISOString(),
    }));
  }

  private async item(id: string): Promise<DeviceItem> {
    const found = (await this.list()).find((d) => d.id === id);
    if (!found) throw new NotFoundException('Caja no encontrada');
    return found;
  }

  async create(emissionPointId: string, name: string): Promise<DevicePairingCode> {
    const { tenantId, userId } = currentContext();
    const id = uuidv7();
    const code = newPairingCode();
    const expiresAt = new Date(Date.now() + PAIRING_MINUTES * 60_000);
    await this.prisma.tx(async (tx) => {
      const ep = await tx.emissionPoint.findFirst({ where: { id: emissionPointId } });
      if (!ep || !ep.active) throw new NotFoundException('Punto de emisión no encontrado');
      if (ep.kind !== 'DESKTOP') {
        throw new UnprocessableEntityException('El punto de emisión debe ser de tipo "Caja de escritorio" (Estructura → editar el punto de emisión)');
      }
      const existing = await tx.device.findFirst({ where: { emissionPointId } });
      if (existing) throw new ConflictException('Ese punto de emisión ya tiene una caja. Use "Nuevo código" para vincular otra computadora.');
      const open = await tx.cashSession.findFirst({ where: { emissionPointId, status: 'OPEN' } });
      if (open) throw new ConflictException('Ese punto de emisión tiene una caja abierta en la web; ciérrela primero');
      await tx.device.create({
        data: { id, tenantId: tenantId as string, emissionPointId, name, status: 'pending', pairingCodeHash: sha256(code), pairingExpiresAt: expiresAt, createdBy: userId ?? null },
      });
      await this.audit.record(tx, { action: 'device.create', entity: 'device', entityId: id, after: { emissionPointId, name } });
    });
    return { device: await this.item(id), code, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Nuevo código de vinculación (computadora nueva o reinstalación). El token anterior deja de
   * servir en cuanto la nueva computadora se vincula.
   */
  async newPairingCode(id: string): Promise<DevicePairingCode> {
    const code = newPairingCode();
    const expiresAt = new Date(Date.now() + PAIRING_MINUTES * 60_000);
    await this.prisma.tx(async (tx) => {
      const d = await tx.device.findFirst({ where: { id } });
      if (!d) throw new NotFoundException('Caja no encontrada');
      await tx.device.update({
        where: { id },
        data: { pairingCodeHash: sha256(code), pairingExpiresAt: expiresAt, ...(d.status === 'revoked' ? { status: 'pending', revokedAt: null } : {}) },
      });
      await this.audit.record(tx, { action: 'device.pairing_code', entity: 'device', entityId: id });
    });
    return { device: await this.item(id), code, expiresAt: expiresAt.toISOString() };
  }

  async revoke(id: string): Promise<DeviceItem> {
    await this.prisma.tx(async (tx) => {
      const d = await tx.device.findFirst({ where: { id } });
      if (!d) throw new NotFoundException('Caja no encontrada');
      await tx.device.update({ where: { id }, data: { status: 'revoked', tokenHash: null, pairingCodeHash: null, pairingExpiresAt: null, revokedAt: new Date() } });
      await this.audit.record(tx, { action: 'device.revoke', entity: 'device', entityId: id, before: { status: d.status } });
    });
    return this.item(id);
  }

  async ops(id: string, onlyRejected: boolean): Promise<SyncOpItem[]> {
    const rows = await this.prisma.tx((tx) =>
      tx.syncOp.findMany({ where: { deviceId: id, ...(onlyRejected ? { status: 'REJECTED' } : {}) }, orderBy: { processedAt: 'desc' }, take: 200 }),
    );
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      status: r.status as SyncOpItem['status'],
      message: r.message,
      clientAt: r.clientAt.toISOString(),
      processedAt: r.processedAt.toISOString(),
    }));
  }

  /** La caja canjea el código (público, sin sesión): recibe su token permanente. */
  async pair(code: string, fingerprint: string, appVersion: string): Promise<PairDeviceResponse> {
    const row = await this.lookup({ codeHash: sha256(code) });
    if (!row || !row.pairing_expires_at || row.pairing_expires_at < new Date() || row.status === 'revoked') {
      throw new UnauthorizedException('Código de vinculación inválido o vencido. Genere uno nuevo en la web (Administración → Cajas de escritorio).');
    }
    const token = randomBytes(32).toString('base64url');
    await this.prisma.as({ tenantId: row.tenant_id, userId: null }, async (tx) => {
      await tx.device.update({
        where: { id: row.id },
        data: { status: 'active', tokenHash: sha256(token), pairingCodeHash: null, pairingExpiresAt: null, fingerprint, appVersion, lastSeenAt: new Date() },
      });
      await tx.auditLog.create({
        data: { id: uuidv7(), tenantId: row.tenant_id, userId: null, action: 'device.pair', entity: 'device', entityId: row.id, after: { fingerprint, appVersion } },
      });
    });
    return {
      deviceId: row.id,
      tenantId: row.tenant_id,
      emissionPointId: row.emission_point_id,
      token,
      linkKey: deviceLinkKey(row.id),
      publicBaseUrl: publicBaseUrl(),
      serverTime: new Date().toISOString(),
    };
  }
}
