import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { uuidv7 } from '@vektra/db';
import { PermissionGroup, RoleItem, RoleRequest, roleSchema } from '@vektra/shared-contracts';
import { ALL_PERMISSION_CODES, PERMISSION_MODULES, PERMISSIONS } from '@vektra/shared-domain';
import { AuditService } from '../audit/audit.service';
import { SessionService } from '../auth/session.service';
import { RequirePermissions } from '../common/decorators';
import { PrismaService } from '../common/prisma.service';
import { currentContext } from '../common/request-context';
import { ZodPipe } from '@vektra/nest-common';

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
  ) {}

  permissionGroups(): PermissionGroup[] {
    return Object.entries(PERMISSION_MODULES).map(([module, label]) => ({
      module,
      label,
      permissions: PERMISSIONS.filter((p) => p.module === module).map((p) => ({ code: p.code, description: p.description })),
    }));
  }

  async list(): Promise<RoleItem[]> {
    const roles = await this.prisma.tx((tx) =>
      tx.role.findMany({
        include: { permissions: true, _count: { select: { memberships: true } } },
        orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      }),
    );
    return roles.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      isSystem: r.isSystem,
      systemCode: r.systemCode,
      permissions: r.permissions.map((p) => p.permissionCode).sort(),
      memberCount: r._count.memberships,
    }));
  }

  async create(input: RoleRequest): Promise<{ id: string }> {
    this.assertPermissions(input.permissions);
    const tenantId = currentContext().tenantId as string;
    const id = uuidv7();
    await this.prisma.tx(async (tx) => {
      await tx.role.create({ data: { id, tenantId, name: input.name, description: input.description ?? null } });
      await tx.rolePermission.createMany({ data: input.permissions.map((permissionCode) => ({ tenantId, roleId: id, permissionCode })) });
      await this.audit.record(tx, { action: 'create', entity: 'role', entityId: id, after: input });
    });
    return { id };
  }

  async update(id: string, input: RoleRequest): Promise<void> {
    this.assertPermissions(input.permissions);
    const tenantId = currentContext().tenantId as string;
    await this.prisma.tx(async (tx) => {
      const role = await tx.role.findFirst({ where: { id }, include: { permissions: true } });
      if (!role) throw new NotFoundException('Rol no encontrado');
      if (role.systemCode === 'ADMIN' && input.permissions.length !== ALL_PERMISSION_CODES.length) {
        throw new BadRequestException('El rol Administrador siempre tiene todos los permisos');
      }
      await tx.role.update({ where: { id }, data: { name: input.name, description: input.description ?? null } });
      await tx.rolePermission.deleteMany({ where: { roleId: id } });
      await tx.rolePermission.createMany({ data: input.permissions.map((permissionCode) => ({ tenantId, roleId: id, permissionCode })) });
      await this.audit.record(tx, {
        action: 'update',
        entity: 'role',
        entityId: id,
        before: { name: role.name, permissions: role.permissions.map((p) => p.permissionCode) },
        after: input,
      });
    });
    this.sessions.invalidateTenant(tenantId);
  }

  async remove(id: string): Promise<void> {
    await this.prisma.tx(async (tx) => {
      const role = await tx.role.findFirst({ where: { id }, include: { _count: { select: { memberships: true } } } });
      if (!role) throw new NotFoundException('Rol no encontrado');
      if (role.isSystem) throw new ConflictException('Los roles del sistema no se pueden eliminar');
      if (role._count.memberships > 0) throw new ConflictException('El rol tiene usuarios asignados');
      await tx.role.delete({ where: { id } });
      await this.audit.record(tx, { action: 'delete', entity: 'role', entityId: id, before: { name: role.name } });
    });
  }

  private assertPermissions(codes: string[]): void {
    const valid = new Set<string>(ALL_PERMISSION_CODES);
    const invalid = codes.filter((c) => !valid.has(c));
    if (invalid.length) throw new BadRequestException(`Permisos desconocidos: ${invalid.join(', ')}`);
  }
}

@Controller()
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get('permissions')
  @RequirePermissions('roles.read')
  permissions() {
    return this.roles.permissionGroups();
  }

  @Get('roles')
  @RequirePermissions('roles.read')
  list() {
    return this.roles.list();
  }

  @Post('roles')
  @RequirePermissions('roles.manage')
  create(@Body(new ZodPipe(roleSchema)) body: RoleRequest) {
    return this.roles.create(body);
  }

  @Patch('roles/:id')
  @HttpCode(204)
  @RequirePermissions('roles.manage')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(roleSchema)) body: RoleRequest) {
    return this.roles.update(id, body);
  }

  @Delete('roles/:id')
  @HttpCode(204)
  @RequirePermissions('roles.manage')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.roles.remove(id);
  }
}
