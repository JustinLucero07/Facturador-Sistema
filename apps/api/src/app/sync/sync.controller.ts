import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Post, Query, UnauthorizedException } from '@nestjs/common';
import { ZodPipe } from '@vektra/nest-common';
import { syncPushSchema, type SyncPushParsed } from '@vektra/shared-contracts';
import { AllowWithoutLicense, Public } from '../common/decorators';
import { currentContext } from '../common/request-context';
import { DeviceRow, DevicesService, sha256 } from '../devices/devices.service';
import { SyncService } from './sync.service';

/**
 * Sincronización de las cajas de escritorio. No usa la sesión de usuario: la caja se autentica con
 * su token (X-Device-Token) y cada operación indica el usuario que la hizo en la caja.
 * Sin bloqueo por licencia: las ventas que llegan ya ocurrieron (la caja aplica la licencia al vender).
 */
@Controller('sync')
@Public()
@AllowWithoutLicense()
export class SyncController {
  constructor(
    private readonly devices: DevicesService,
    private readonly sync: SyncService,
  ) {}

  private async device(token: string | undefined): Promise<DeviceRow> {
    if (!token || token.length < 20) throw new UnauthorizedException('Caja no vinculada');
    const d = await this.devices.lookup({ tokenHash: sha256(token) });
    if (!d) throw new UnauthorizedException('Caja no vinculada o revocada. Vuelva a vincularla desde la web.');
    if (d.status !== 'active') throw new ForbiddenException('Esta caja fue desactivada. Comuníquese con el administrador.');
    const ctx = currentContext();
    ctx.tenantId = d.tenant_id;
    ctx.userId = undefined;
    return d;
  }

  @Get('pull')
  async pull(@Headers('x-device-token') token: string | undefined, @Query('since') since?: string) {
    return this.sync.pull(await this.device(token), since ?? null);
  }

  @Post('push')
  @HttpCode(200)
  async push(@Headers('x-device-token') token: string | undefined, @Body(new ZodPipe(syncPushSchema)) body: SyncPushParsed) {
    return this.sync.push(await this.device(token), body);
  }
}
