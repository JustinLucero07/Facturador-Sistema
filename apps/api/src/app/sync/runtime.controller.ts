import { Controller, Get } from '@nestjs/common';
import type { RuntimeInfo } from '@vektra/shared-contracts';
import { AllowWithoutLicense, Public } from '../common/decorators';

/** La web pregunta en qué modo corre; la caja de escritorio responde "desktop" desde su servidor local. */
@Controller('runtime')
@Public()
@AllowWithoutLicense()
export class RuntimeController {
  @Get()
  runtime(): RuntimeInfo {
    return { mode: 'web' };
  }
}
