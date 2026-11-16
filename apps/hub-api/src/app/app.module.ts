import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { HttpErrorFilter } from '@vektra/nest-common';
import { HubAuthGuard, hubEnv, HubPrisma } from './core';
import {
  ClientsController,
  HubAuthController,
  HubHealthController,
  InstallationsController,
  LicenseEndpointController,
  PlansController,
} from './hub.controllers';
import { LicenseIssuer } from './license-issuer.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      useFactory: () => ({ secret: hubEnv().HUB_JWT_SECRET, signOptions: { issuer: 'vektra-hub' }, verifyOptions: { issuer: 'vektra-hub' } }),
    }),
  ],
  controllers: [HubAuthController, PlansController, ClientsController, InstallationsController, LicenseEndpointController, HubHealthController],
  providers: [
    HubPrisma,
    LicenseIssuer,
    { provide: APP_GUARD, useClass: HubAuthGuard },
    { provide: APP_FILTER, useClass: HttpErrorFilter },
  ],
})
export class AppModule {}
