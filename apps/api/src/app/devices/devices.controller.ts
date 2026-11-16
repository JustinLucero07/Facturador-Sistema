import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ZodPipe } from '@vektra/nest-common';
import { createDeviceSchema, pairDeviceSchema } from '@vektra/shared-contracts';
import { z } from 'zod';
import { AllowWithoutLicense, Public, RequirePermissions } from '../common/decorators';
import { DevicesService } from './devices.service';

@Controller()
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get('devices')
  @RequirePermissions('structure.read')
  list() {
    return this.devices.list();
  }

  @Post('devices')
  @RequirePermissions('structure.manage')
  create(@Body(new ZodPipe(createDeviceSchema)) b: z.output<typeof createDeviceSchema>) {
    return this.devices.create(b.emissionPointId, b.name);
  }

  @Post('devices/:id/pairing-code')
  @HttpCode(200)
  @RequirePermissions('structure.manage')
  pairingCode(@Param('id', ParseUUIDPipe) id: string) {
    return this.devices.newPairingCode(id);
  }

  @Post('devices/:id/revoke')
  @HttpCode(200)
  @RequirePermissions('structure.manage')
  revoke(@Param('id', ParseUUIDPipe) id: string) {
    return this.devices.revoke(id);
  }

  @Get('devices/:id/ops')
  @RequirePermissions('structure.read')
  ops(@Param('id', ParseUUIDPipe) id: string, @Query('rejected') rejected?: string) {
    return this.devices.ops(id, rejected === 'true');
  }

  /** La caja de escritorio canjea el código de vinculación (sin sesión de usuario). */
  @Post('devices/pair')
  @HttpCode(200)
  @Public()
  @AllowWithoutLicense()
  pair(@Body(new ZodPipe(pairDeviceSchema)) b: z.output<typeof pairDeviceSchema>) {
    return this.devices.pair(b.code, b.fingerprint, b.appVersion);
  }
}
