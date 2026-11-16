import { Body, Controller, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Tx, uuidv7 } from '@vektra/db';
import {
  EmissionPointRequest,
  emissionPointSchema,
  EstablishmentItem,
  EstablishmentRequest,
  establishmentSchema,
  WarehouseRequest,
  warehouseSchema,
} from '@vektra/shared-contracts';
import { AuditService } from '../audit/audit.service';
import { RequirePermissions } from '../common/decorators';
import { PrismaService } from '../common/prisma.service';
import { currentContext } from '../common/request-context';
import { ZodPipe } from '@vektra/nest-common';
import { LicenseService } from '../license/license.service';

@Injectable()
export class StructureService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly license: LicenseService,
  ) {}

  async list(): Promise<EstablishmentItem[]> {
    const rows = await this.prisma.tx((tx) =>
      tx.establishment.findMany({
        orderBy: { code: 'asc' },
        include: {
          emissionPoints: { orderBy: { code: 'asc' }, include: { device: true } },
          warehouses: { orderBy: { name: 'asc' } },
        },
      }),
    );
    return rows.map((e) => ({
      id: e.id,
      code: e.code,
      name: e.name,
      address: e.address,
      active: e.active,
      emissionPoints: e.emissionPoints.map((p) => ({
        id: p.id,
        code: p.code,
        name: p.name,
        kind: p.kind,
        active: p.active,
        deviceName: p.device?.name ?? null,
      })),
      warehouses: e.warehouses.map((w) => ({ id: w.id, name: w.name, isDefault: w.isDefault, active: w.active })),
    }));
  }

  async createEstablishment(input: EstablishmentRequest) {
    await this.license.assertLimit('establishments');
    const tenantId = currentContext().tenantId as string;
    const id = uuidv7();
    await this.prisma.tx(async (tx) => {
      await tx.establishment.create({ data: { id, tenantId, ...input } });
      // Cada establecimiento nace con su bodega principal.
      await tx.warehouse.create({ data: { id: uuidv7(), tenantId, establishmentId: id, name: 'Bodega principal', isDefault: true } });
      await this.audit.record(tx, { action: 'create', entity: 'establishment', entityId: id, after: input });
    });
    return { id };
  }

  async updateEstablishment(id: string, input: EstablishmentRequest) {
    await this.prisma.tx(async (tx) => {
      const before = await tx.establishment.findFirst({ where: { id } });
      if (!before) throw new NotFoundException('Establecimiento no encontrado');
      await tx.establishment.update({ where: { id }, data: input });
      await this.audit.record(tx, { action: 'update', entity: 'establishment', entityId: id, before, after: input });
    });
  }

  async createEmissionPoint(input: EmissionPointRequest) {
    await this.license.assertLimit('emissionPoints');
    const tenantId = currentContext().tenantId as string;
    const id = uuidv7();
    await this.prisma.tx(async (tx) => {
      await this.assertEstablishment(tx, input.establishmentId);
      await tx.emissionPoint.create({ data: { id, tenantId, ...input } });
      await this.audit.record(tx, { action: 'create', entity: 'emission_point', entityId: id, after: input });
    });
    return { id };
  }

  async updateEmissionPoint(id: string, input: EmissionPointRequest) {
    await this.prisma.tx(async (tx) => {
      const before = await tx.emissionPoint.findFirst({ where: { id } });
      if (!before) throw new NotFoundException('Punto de emisión no encontrado');
      await this.assertEstablishment(tx, input.establishmentId);
      await tx.emissionPoint.update({ where: { id }, data: input });
      await this.audit.record(tx, { action: 'update', entity: 'emission_point', entityId: id, before, after: input });
    });
  }

  async createWarehouse(input: WarehouseRequest) {
    const tenantId = currentContext().tenantId as string;
    const id = uuidv7();
    await this.prisma.tx(async (tx) => {
      await this.assertEstablishment(tx, input.establishmentId);
      if (input.isDefault) await tx.warehouse.updateMany({ where: { establishmentId: input.establishmentId }, data: { isDefault: false } });
      await tx.warehouse.create({ data: { id, tenantId, ...input } });
      await this.audit.record(tx, { action: 'create', entity: 'warehouse', entityId: id, after: input });
    });
    return { id };
  }

  async updateWarehouse(id: string, input: WarehouseRequest) {
    await this.prisma.tx(async (tx) => {
      const before = await tx.warehouse.findFirst({ where: { id } });
      if (!before) throw new NotFoundException('Bodega no encontrada');
      await this.assertEstablishment(tx, input.establishmentId);
      if (input.isDefault) await tx.warehouse.updateMany({ where: { establishmentId: input.establishmentId, NOT: { id } }, data: { isDefault: false } });
      await tx.warehouse.update({ where: { id }, data: input });
      await this.audit.record(tx, { action: 'update', entity: 'warehouse', entityId: id, before, after: input });
    });
  }

  private async assertEstablishment(tx: Tx, id: string) {
    if (!(await tx.establishment.findFirst({ where: { id }, select: { id: true } }))) {
      throw new NotFoundException('Establecimiento no encontrado');
    }
  }
}

@Controller()
export class StructureController {
  constructor(private readonly structure: StructureService) {}

  @Get('establishments')
  @RequirePermissions('structure.read')
  list() {
    return this.structure.list();
  }

  @Post('establishments')
  @RequirePermissions('structure.manage')
  createEstablishment(@Body(new ZodPipe(establishmentSchema)) body: EstablishmentRequest) {
    return this.structure.createEstablishment(body);
  }

  @Patch('establishments/:id')
  @HttpCode(204)
  @RequirePermissions('structure.manage')
  updateEstablishment(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(establishmentSchema)) body: EstablishmentRequest) {
    return this.structure.updateEstablishment(id, body);
  }

  @Post('emission-points')
  @RequirePermissions('structure.manage')
  createEmissionPoint(@Body(new ZodPipe(emissionPointSchema)) body: EmissionPointRequest) {
    return this.structure.createEmissionPoint(body);
  }

  @Patch('emission-points/:id')
  @HttpCode(204)
  @RequirePermissions('structure.manage')
  updateEmissionPoint(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(emissionPointSchema)) body: EmissionPointRequest) {
    return this.structure.updateEmissionPoint(id, body);
  }

  @Post('warehouses')
  @RequirePermissions('structure.manage')
  createWarehouse(@Body(new ZodPipe(warehouseSchema)) body: WarehouseRequest) {
    return this.structure.createWarehouse(body);
  }

  @Patch('warehouses/:id')
  @HttpCode(204)
  @RequirePermissions('structure.manage')
  updateWarehouse(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(warehouseSchema)) body: WarehouseRequest) {
    return this.structure.updateWarehouse(id, body);
  }
}
