import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { activateLicenseSchema } from '@vektra/shared-contracts';
import { AuditService } from '../audit/audit.service';
import { AllowWithoutLicense, Public, RequirePermissions } from '../common/decorators';
import { currentContext } from '../common/request-context';
import { ZodPipe } from '@vektra/nest-common';
import { LicenseService } from './license.service';

@Controller()
export class LicenseController {
  constructor(
    private readonly license: LicenseService,
    private readonly audit: AuditService,
  ) {}

  /** Cualquier usuario autenticado ve el estado (para el aviso en pantalla). */
  @Get('license')
  status() {
    return this.license.status(currentContext().tenantId);
  }

  @Post('license/activate')
  @HttpCode(200)
  @AllowWithoutLicense()
  @RequirePermissions('license.manage')
  async activate(@Body(new ZodPipe(activateLicenseSchema)) body: { code: string }) {
    const status = await this.license.activate(body.code);
    const ctx = currentContext();
    await this.audit.recordStandalone(ctx.tenantId ?? null, ctx.userId ?? null, {
      action: 'license.activated',
      entity: 'license',
      after: { plan: status.plan, expiresAt: status.expiresAt, kind: status.kind },
    });
    return status;
  }

  @Public()
  @Get('health')
  health() {
    return { status: 'ok', time: new Date().toISOString() };
  }
}
