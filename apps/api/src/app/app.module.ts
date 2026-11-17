import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { redisConnection, SRI_QUEUE } from '@vektra/einvoice';
import { EInvoiceController } from './einvoice/einvoice.controller';
import { EInvoiceService } from './einvoice/einvoice.service';
import { TaxController, TaxService } from './einvoice/tax.controller';
import { CatalogController, CatalogService } from './catalog/catalog.controller';
import { ImportsController } from './catalog/imports.controller';
import { ImportsService } from './catalog/imports.service';
import { InventoryController, InventoryService } from './catalog/inventory.controller';
import { PartiesController, PartiesService } from './catalog/parties.controller';
import { ProductsController } from './catalog/products.controller';
import { ProductsService } from './catalog/products.service';
import { CashService } from './pos/cash.service';
import { PosController, PosService } from './pos/pos.controller';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuditController } from './audit/audit.controller';
import { DevicesController } from './devices/devices.controller';
import { DevicesService } from './devices/devices.service';
import { SyncController } from './sync/sync.controller';
import { AccountsController } from './accounts/accounts.controller';
import { AccountsService } from './accounts/accounts.service';
import { AtsService } from './reports/ats.service';
import { ReportsController } from './reports/reports.controller';
import { ReportsService } from './reports/reports.service';
import { PurchasesController } from './purchases/purchases.controller';
import { PurchasesService } from './purchases/purchases.service';
import { RuntimeController } from './sync/runtime.controller';
import { SyncService } from './sync/sync.service';
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
    BullModule.forRootAsync({ useFactory: () => ({ connection: redisConnection(getEnv().REDIS_URL) }) }),
    BullModule.registerQueue({ name: SRI_QUEUE }),
    JwtModule.registerAsync({
      useFactory: () => ({ secret: getEnv().JWT_ACCESS_SECRET, signOptions: { issuer: 'vektra-pos' }, verifyOptions: { issuer: 'vektra-pos' } }),
    }),
  ],
  controllers: [
    AuthController,
    DevicesController,
    SyncController,
    AccountsController,
    ReportsController,
    PurchasesController,
    RuntimeController,
    UsersController,
    RolesController,
    StructureController,
    CompanyController,
    AuditController,
    LicenseController,
    EInvoiceController,
    TaxController,
    CatalogController,
    ProductsController,
    PartiesController,
    InventoryController,
    ImportsController,
    PosController,
  ],
  providers: [
    PrismaService,
    DevicesService,
    SyncService,
    AccountsService,
    ReportsService,
    AtsService,
    PurchasesService,
    AuditService,
    LicenseService,
    SessionService,
    TokenService,
    AuthService,
    UsersService,
    RolesService,
    StructureService,
    CompanyService,
    EInvoiceService,
    TaxService,
    CatalogService,
    ProductsService,
    PartiesService,
    InventoryService,
    ImportsService,
    CashService,
    PosService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: HttpErrorFilter },
  ],
})
export class AppModule {}
