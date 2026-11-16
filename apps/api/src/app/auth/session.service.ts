import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ALL_PERMISSION_CODES } from '@vektra/shared-domain';
import { PrismaService } from '../common/prisma.service';

export interface LoadedSession {
  userId: string;
  tenantId: string;
  membershipId: string | null;
  isSupport: boolean;
  permissions: ReadonlySet<string>;
}

const TTL_MS = 30_000;

/**
 * Resuelve usuario + empresa + permisos de un access token. Caché corta en memoria;
 * se invalida al cambiar roles, usuarios o contraseñas.
 */
@Injectable()
export class SessionService {
  private cache = new Map<string, { at: number; session: LoadedSession }>();

  constructor(private readonly prisma: PrismaService) {}

  invalidateUser(userId: string): void {
    for (const key of this.cache.keys()) if (key.startsWith(`${userId}:`)) this.cache.delete(key);
  }

  invalidateTenant(tenantId: string): void {
    for (const [key, v] of this.cache) if (v.session.tenantId === tenantId) this.cache.delete(key);
  }

  async load(userId: string, tenantId: string, tokenVersion: number): Promise<LoadedSession> {
    const key = `${userId}:${tenantId}:${tokenVersion}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.session;

    const user = await this.prisma.client.user.findUnique({ where: { id: userId } });
    if (!user || !user.active || user.tokenVersion !== tokenVersion) {
      throw new UnauthorizedException('Su sesión ya no es válida. Inicie sesión nuevamente.');
    }
    const tenant = await this.prisma.client.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new UnauthorizedException('La empresa ya no existe');

    let session: LoadedSession;
    if (user.isSupport) {
      session = { userId, tenantId, membershipId: null, isSupport: true, permissions: new Set(ALL_PERMISSION_CODES) };
    } else {
      if (tenant.status !== 'ACTIVE') throw new ForbiddenException('La empresa está suspendida. Comuníquese con el administrador.');
      const membership = await this.prisma.as({ tenantId, userId }, (tx) =>
        tx.membership.findFirst({
          where: { tenantId, userId, active: true },
          include: { roles: { include: { role: { include: { permissions: true } } } } },
        }),
      );
      if (!membership) throw new UnauthorizedException('Ya no tiene acceso a esta empresa');
      const permissions = new Set<string>();
      for (const mr of membership.roles) for (const rp of mr.role.permissions) permissions.add(rp.permissionCode);
      session = { userId, tenantId, membershipId: membership.id, isSupport: false, permissions };
    }

    this.cache.set(key, { at: Date.now(), session });
    return session;
  }
}
