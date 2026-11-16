import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuditController } from './audit/audit.controller';
import { AuditService } from './audit/audit.service';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { SessionService } from './auth/session.service';
import { TokenService } from './auth/token.service';
import { HttpErrorFilter } from '@vektra/nest-common';
import { PrismaService } from './common/prisma.service';
import { CompanyController, CompanyService } from './company/company.controller';
import { getEnv } from './config/env';
import { LicenseController } from './license/license.controller';
import { LicenseService } from './license/license.service';
import { RolesController, RolesService } from './roles/roles.controller';
import { StructureController, StructureService } from './structure/structure.controller';
import { UsersController } from './users/users.controller';
import { UsersService } from './users/users.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      useFactory: () => ({ secret: getEnv().JWT_ACCESS_SECRET, signOptions: { issuer: 'vektra-pos' }, verifyOptions: { issuer: 'vektra-pos' } }),
    }),
  ],
  controllers: [
    AuthController,
    UsersController,
    RolesController,
    StructureController,
    CompanyController,
    AuditController,
    LicenseController,
  ],
  providers: [
    PrismaService,
    AuditService,
    LicenseService,
    SessionService,
    TokenService,
    AuthService,
    UsersService,
    RolesService,
    StructureService,
    CompanyService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: HttpErrorFilter },
  ],
})
export class AppModule {}
