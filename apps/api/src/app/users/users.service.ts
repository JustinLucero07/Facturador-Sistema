import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import { Tx, uuidv7 } from '@vektra/db';
import type { CreateUserRequest, UpdateUserRequest, UserListItem } from '@vektra/shared-contracts';
import { AuditService } from '../audit/audit.service';
import { SessionService } from '../auth/session.service';
import { TokenService } from '../auth/token.service';
import { PrismaService } from '../common/prisma.service';
import { currentContext } from '../common/request-context';
import { LicenseService } from '../license/license.service';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly license: LicenseService,
  ) {}

  async list(): Promise<UserListItem[]> {
    const tenantId = currentContext().tenantId as string;
    const memberships = await this.prisma.tx((tx) =>
      tx.membership.findMany({
        where: { tenantId },
        include: { user: true, roles: { include: { role: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    );
    const now = new Date();
    return memberships.map((m) => ({
      membershipId: m.id,
      userId: m.userId,
      email: m.user.email,
      fullName: m.user.fullName,
      active: m.active && m.user.active,
      locked: !!m.user.lockedUntil && m.user.lockedUntil > now,
      totpEnabled: m.user.totpEnabled,
      lastLoginAt: m.user.lastLoginAt?.toISOString() ?? null,
      roles: m.roles.map((r) => ({ id: r.role.id, name: r.role.name })),
      defaultEstablishmentId: m.defaultEstablishmentId,
    }));
  }

  async create(input: CreateUserRequest): Promise<{ membershipId: string; existingUser: boolean }> {
    const tenantId = currentContext().tenantId as string;
    const existing = await this.prisma.client.user.findUnique({ where: { email: input.email } });
    if (existing?.isSupport) throw new ConflictException('Ese correo pertenece a Soporte Vektra');
    if (!existing) {
      if (!input.password) {
        throw new BadRequestException({ message: 'Revise los datos ingresados', fields: { password: 'Ingrese una contraseña inicial' } });
      }
      await this.license.assertLimit('users');
    }
    const passwordHash = input.password && !existing ? await hash(input.password) : null;

    return this.prisma.tx(async (tx) => {
      await this.assertRoles(tx, input.roleIds);
      let userId = existing?.id;
      if (existing) {
        const already = await tx.membership.findFirst({ where: { tenantId, userId: existing.id } });
        if (already) throw new ConflictException('El usuario ya pertenece a esta empresa');
      } else {
        userId = uuidv7();
        await tx.user.create({ data: { id: userId, email: input.email, fullName: input.fullName, passwordHash: passwordHash as string } });
      }
      const membershipId = uuidv7();
      await tx.membership.create({
        data: { id: membershipId, tenantId, userId: userId as string, defaultEstablishmentId: input.defaultEstablishmentId ?? null },
      });
      await tx.membershipRole.createMany({ data: input.roleIds.map((roleId) => ({ tenantId, membershipId, roleId })) });
      await this.audit.record(tx, {
        action: 'create',
        entity: 'user',
        entityId: userId,
        after: { email: input.email, fullName: input.fullName, roleIds: input.roleIds, existingUser: !!existing },
      });
      return { membershipId, existingUser: !!existing };
    });
  }

  async update(membershipId: string, input: UpdateUserRequest): Promise<void> {
    const ctx = currentContext();
    const tenantId = ctx.tenantId as string;
    const userId = await this.prisma.tx(async (tx) => {
      const m = await this.findMembership(tx, membershipId);
      if (m.userId === ctx.userId && (input.active === false || input.roleIds)) {
        throw new ForbiddenException('No puede desactivarse ni cambiar sus propios roles');
      }
      if (input.roleIds) {
        await this.assertRoles(tx, input.roleIds);
        await tx.membershipRole.deleteMany({ where: { membershipId } });
        await tx.membershipRole.createMany({ data: input.roleIds.map((roleId) => ({ tenantId, membershipId, roleId })) });
      }
      await tx.membership.update({
        where: { id: membershipId },
        data: {
          ...(input.active !== undefined ? { active: input.active } : {}),
          ...(input.defaultEstablishmentId !== undefined ? { defaultEstablishmentId: input.defaultEstablishmentId } : {}),
        },
      });
      if (input.fullName) await tx.user.update({ where: { id: m.userId }, data: { fullName: input.fullName } });
      await this.audit.record(tx, {
        action: 'update',
        entity: 'user',
        entityId: m.userId,
        before: { fullName: m.user.fullName, active: m.active, roleIds: m.roles.map((r) => r.roleId) },
        after: input,
      });
      return m.userId;
    });
    this.sessions.invalidateUser(userId);
    if (input.active === false) await this.tokens.revokeAllForUser(userId);
  }

  async resetPassword(membershipId: string, newPassword: string): Promise<void> {
    const passwordHash = await hash(newPassword);
    const userId = await this.prisma.tx(async (tx) => {
      const m = await this.findMembership(tx, membershipId);
      if (m.user.isSupport) throw new ForbiddenException();
      await tx.user.update({
        where: { id: m.userId },
        data: { passwordHash, tokenVersion: { increment: 1 }, failedAttempts: 0, lockedUntil: null },
      });
      await this.audit.record(tx, { action: 'password.reset', entity: 'user', entityId: m.userId });
      return m.userId;
    });
    await this.tokens.revokeAllForUser(userId);
    this.sessions.invalidateUser(userId);
  }

  async unlock(membershipId: string): Promise<void> {
    await this.prisma.tx(async (tx) => {
      const m = await this.findMembership(tx, membershipId);
      await tx.user.update({ where: { id: m.userId }, data: { failedAttempts: 0, lockedUntil: null } });
      await this.audit.record(tx, { action: 'unlock', entity: 'user', entityId: m.userId });
    });
  }

  private async findMembership(tx: Tx, membershipId: string) {
    const m = await tx.membership.findFirst({ where: { id: membershipId }, include: { user: true, roles: true } });
    if (!m) throw new NotFoundException('Usuario no encontrado');
    return m;
  }

  /** Los roles deben existir en la empresa actual (RLS ya filtra los de otras empresas). */
  private async assertRoles(tx: Tx, roleIds: string[]): Promise<void> {
    const count = await tx.role.count({ where: { id: { in: roleIds } } });
    if (count !== new Set(roleIds).size) {
      throw new BadRequestException({ message: 'Revise los datos ingresados', fields: { roleIds: 'Algún rol no existe' } });
    }
  }
}
