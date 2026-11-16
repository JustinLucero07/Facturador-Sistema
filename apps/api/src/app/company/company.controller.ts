import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Injectable,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import { provisionTenant } from '@vektra/db';
import {
  CompanyInfo,
  CreateTenantRequest,
  createTenantSchema,
  TenantAdminItem,
  toggleModuleSchema,
  UpdateCompanyRequest,
  updateCompanySchema,
} from '@vektra/shared-contracts';
import { MODULES, validateRuc } from '@vektra/shared-domain';
import { AuditService } from '../audit/audit.service';
import { SessionService } from '../auth/session.service';
import { RequirePermissions, SupportOnly } from '../common/decorators';
import { PrismaService } from '../common/prisma.service';
import { currentContext } from '../common/request-context';
import { ZodPipe } from '@vektra/nest-common';
import { LicenseService } from '../license/license.service';

@Injectable()
export class CompanyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly license: LicenseService,
    private readonly sessions: SessionService,
  ) {}

  async get(): Promise<CompanyInfo> {
    const tenantId = currentContext().tenantId as string;
    const tenant = await this.prisma.client.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const modules = await this.prisma.tx((tx) => tx.tenantModule.findMany());
    const enabled = new Map(modules.map((m) => [m.moduleCode, m.enabled]));
    return {
      id: tenant.id,
      ruc: tenant.ruc,
      legalName: tenant.legalName,
      tradeName: tenant.tradeName,
      mainAddress: tenant.mainAddress,
      taxRegime: tenant.taxRegime,
      environment: tenant.environment,
      keepsAccounting: tenant.keepsAccounting,
      specialTaxpayerNumber: tenant.specialTaxpayerNumber,
      withholdingAgentNumber: tenant.withholdingAgentNumber,
      businessTemplate: tenant.businessTemplate,
      settings: tenant.settings as CompanyInfo['settings'],
      modules: await Promise.all(
        Object.entries(MODULES).map(async ([code, def]) => ({
          code,
          name: def.name,
          description: def.description,
          enabled: enabled.get(code) ?? false,
          allowedByPlan: await this.license.isModuleAllowed(code),
        })),
      ),
    };
  }

  async update(input: UpdateCompanyRequest): Promise<void> {
    const tenantId = currentContext().tenantId as string;
    const before = await this.prisma.client.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const { settings, ...data } = input;
    await this.prisma.tx(async (tx) => {
      await tx.tenant.update({
        where: { id: tenantId },
        data: { ...data, settings: { ...(before.settings as object), ...(settings ?? {}) } },
      });
      await this.audit.record(tx, { action: 'update', entity: 'company', entityId: tenantId, before, after: input });
    });
  }

  async toggleModule(code: string, enabled: boolean): Promise<void> {
    if (!(code in MODULES)) throw new NotFoundException('Módulo desconocido');
    if (enabled && !(await this.license.isModuleAllowed(code))) {
      throw new ForbiddenException('Este módulo no está incluido en su plan. Contacte a Vektra para activarlo.');
    }
    const tenantId = currentContext().tenantId as string;
    await this.prisma.tx(async (tx) => {
      await tx.tenantModule.upsert({
        where: { tenantId_moduleCode: { tenantId, moduleCode: code } },
        create: { tenantId, moduleCode: code, enabled },
        update: { enabled },
      });
      await this.audit.record(tx, { action: enabled ? 'module.enabled' : 'module.disabled', entity: 'company', entityId: code });
    });
  }

  // ───────────── Soporte Vektra ─────────────

  async listTenants(): Promise<TenantAdminItem[]> {
    const rows = await this.prisma.client.tenant.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map((t) => ({
      id: t.id,
      ruc: t.ruc,
      legalName: t.legalName,
      tradeName: t.tradeName,
      status: t.status,
      businessTemplate: t.businessTemplate,
      environment: t.environment,
      createdAt: t.createdAt.toISOString(),
    }));
  }

  async createTenant(input: CreateTenantRequest) {
    const ruc = validateRuc(input.ruc);
    if (!ruc.valid || ruc.kind === 'FINAL_CONSUMER') {
      throw new BadRequestException({ message: 'Revise los datos ingresados', fields: { ruc: ruc.error ?? 'RUC inválido' } });
    }
    await this.license.assertLimit('tenants');
    if (await this.prisma.client.tenant.findUnique({ where: { ruc: input.ruc } })) {
      throw new ConflictException('Ya existe una empresa con ese RUC');
    }
    const existingUser = await this.prisma.client.user.findUnique({ where: { email: input.admin.email } });
    if (existingUser?.isSupport) throw new ConflictException('Ese correo pertenece a Soporte Vektra');
    const result = await provisionTenant(this.prisma.client, {
      ruc: input.ruc,
      legalName: input.legalName,
      tradeName: input.tradeName,
      mainAddress: input.mainAddress,
      taxRegime: input.taxRegime,
      keepsAccounting: input.keepsAccounting,
      businessTemplate: input.businessTemplate,
      admin: existingUser
        ? { userId: existingUser.id }
        : { email: input.admin.email, fullName: input.admin.fullName, passwordHash: await hash(input.admin.password) },
    });
    await this.audit.recordStandalone(result.tenantId, currentContext().userId ?? null, {
      action: 'create',
      entity: 'tenant',
      entityId: result.tenantId,
      after: { ...input, admin: { email: input.admin.email }, rucCheckDigitWarning: ruc.checkDigitWarning ?? false },
    });
    return { ...result, rucCheckDigitWarning: ruc.checkDigitWarning ?? false };
  }

  async setTenantStatus(id: string, status: 'ACTIVE' | 'SUSPENDED'): Promise<void> {
    await this.prisma.client.tenant.update({ where: { id }, data: { status } });
    this.sessions.invalidateTenant(id);
    await this.audit.recordStandalone(id, currentContext().userId ?? null, { action: `tenant.${status.toLowerCase()}`, entity: 'tenant', entityId: id });
  }
}

@Controller()
export class CompanyController {
  constructor(private readonly company: CompanyService) {}

  @Get('company')
  @RequirePermissions('company.read')
  get() {
    return this.company.get();
  }

  @Patch('company')
  @HttpCode(204)
  @RequirePermissions('company.update')
  update(@Body(new ZodPipe(updateCompanySchema)) body: UpdateCompanyRequest) {
    return this.company.update(body);
  }

  @Patch('company/modules/:code')
  @HttpCode(204)
  @RequirePermissions('company.update')
  toggleModule(@Param('code') code: string, @Body(new ZodPipe(toggleModuleSchema)) body: { enabled: boolean }) {
    return this.company.toggleModule(code, body.enabled);
  }

  @Get('admin/tenants')
  @SupportOnly()
  listTenants() {
    return this.company.listTenants();
  }

  @Post('admin/tenants')
  @SupportOnly()
  createTenant(@Body(new ZodPipe(createTenantSchema)) body: CreateTenantRequest) {
    return this.company.createTenant(body);
  }

  @Post('admin/tenants/:id/suspend')
  @HttpCode(204)
  @SupportOnly()
  suspend(@Param('id') id: string) {
    return this.company.setTenantStatus(id, 'SUSPENDED');
  }

  @Post('admin/tenants/:id/activate')
  @HttpCode(204)
  @SupportOnly()
  activate(@Param('id') id: string) {
    return this.company.setTenantStatus(id, 'ACTIVE');
  }
}
