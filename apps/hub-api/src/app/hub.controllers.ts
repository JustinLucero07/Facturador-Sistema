import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { hash, verify } from '@node-rs/argon2';
import { Prisma } from '@vektra/hub-db';
import { ZodPipe } from '@vektra/nest-common';
import {
  ClientItem,
  ClientRequest,
  clientSchema,
  CreateInstallationRequest,
  createInstallationSchema,
  hubLoginSchema,
  InstallationCredentials,
  InstallationItem,
  LicenseValidateRequest,
  licenseValidateSchema,
  PlanItem,
  PlanRequest,
  planSchema,
  UpdateInstallationRequest,
  updateInstallationSchema,
} from '@vektra/shared-contracts';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { hubEnv, HubPrisma, HubPublic, HubRequest } from './core';
import { LicenseIssuer } from './license-issuer.service';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const DUMMY = hash('hub-dummy-password');

@Controller('hub/auth')
export class HubAuthController {
  constructor(
    private readonly prisma: HubPrisma,
    private readonly jwt: JwtService,
  ) {}

  @HubPublic()
  @Post('login')
  @HttpCode(200)
  async login(@Body(new ZodPipe(hubLoginSchema)) body: { email: string; password: string }) {
    const user = await this.prisma.db.hubUser.findUnique({ where: { email: body.email } });
    const ok = user?.active ? await verify(user.passwordHash, body.password) : await verify(await DUMMY, body.password).then(() => false);
    if (!user || !ok) throw new UnauthorizedException('Correo o contraseña incorrectos');
    await this.prisma.db.hubUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const accessToken = await this.jwt.signAsync({ sub: user.id, typ: 'hub' }, { expiresIn: 8 * 3600 });
    return { accessToken, user: { id: user.id, email: user.email, fullName: user.fullName } };
  }
}

@Controller('hub/plans')
export class PlansController {
  constructor(private readonly prisma: HubPrisma) {}

  @Get()
  async list(): Promise<PlanItem[]> {
    const plans = await this.prisma.db.plan.findMany({ include: { _count: { select: { installations: true } } }, orderBy: { priceMonthly: 'asc' } });
    return plans.map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      priceMonthly: Number(p.priceMonthly),
      priceYearly: p.priceYearly === null ? null : Number(p.priceYearly),
      limits: p.limits as PlanItem['limits'],
      active: p.active,
      installationCount: p._count.installations,
    }));
  }

  @Post()
  async create(@Body(new ZodPipe(planSchema)) body: PlanRequest) {
    const id = randomUUID();
    await this.prisma.db.plan.create({ data: { id, ...body, priceYearly: body.priceYearly ?? null } });
    return { id };
  }

  @Patch(':id')
  @HttpCode(204)
  async update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(planSchema)) body: PlanRequest) {
    await this.prisma.db.plan.update({ where: { id }, data: { ...body, priceYearly: body.priceYearly ?? null } });
  }
}

@Controller('hub/clients')
export class ClientsController {
  constructor(private readonly prisma: HubPrisma) {}

  @Get()
  async list(): Promise<ClientItem[]> {
    const rows = await this.prisma.db.client.findMany({ include: { _count: { select: { installations: true } } }, orderBy: { legalName: 'asc' } });
    return rows.map(({ _count, createdAt, updatedAt: _u, ...c }) => ({ ...c, installationCount: _count.installations, createdAt: createdAt.toISOString() }));
  }

  @Post()
  async create(@Body(new ZodPipe(clientSchema)) body: ClientRequest) {
    const id = randomUUID();
    try {
      await this.prisma.db.client.create({ data: { id, ...body } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('Ya existe un cliente con ese RUC');
      throw e;
    }
    return { id };
  }

  @Patch(':id')
  @HttpCode(204)
  async update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(clientSchema)) body: ClientRequest) {
    await this.prisma.db.client.update({ where: { id }, data: body });
  }
}

@Controller('hub/installations')
export class InstallationsController {
  constructor(
    private readonly prisma: HubPrisma,
    private readonly issuer: LicenseIssuer,
  ) {}

  @Get()
  async list(): Promise<InstallationItem[]> {
    const rows = await this.prisma.db.installation.findMany({ include: { client: true, plan: true }, orderBy: { createdAt: 'desc' } });
    return rows.map((i) => ({
      id: i.id,
      name: i.name,
      publicId: i.publicId,
      clientId: i.clientId,
      clientName: i.client.tradeName ?? i.client.legalName,
      planId: i.planId,
      planName: i.plan.name,
      status: i.status,
      baseUrl: i.baseUrl,
      rucs: i.rucs,
      lastSeenAt: i.lastSeenAt?.toISOString() ?? null,
      appVersion: i.appVersion,
      lastReport: (i.lastReport as Record<string, unknown> | null) ?? null,
      createdAt: i.createdAt.toISOString(),
    }));
  }

  @Post()
  async create(@Body(new ZodPipe(createInstallationSchema)) body: CreateInstallationRequest): Promise<InstallationCredentials> {
    const secret = randomBytes(32).toString('base64url');
    const publicId = `inst_${randomBytes(9).toString('base64url')}`;
    await this.prisma.db.installation.create({
      data: { id: randomUUID(), publicId, secretHash: sha256(secret), ...body, baseUrl: body.baseUrl ?? null },
    });
    return this.credentials(publicId, secret);
  }

  @Patch(':id')
  @HttpCode(204)
  async update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateInstallationSchema)) body: UpdateInstallationRequest) {
    const { limitOverrides, ...rest } = body;
    await this.prisma.db.installation.update({
      where: { id },
      data: {
        ...rest,
        ...(limitOverrides !== undefined ? { limitOverrides: limitOverrides === null ? Prisma.DbNull : limitOverrides } : {}),
      },
    });
  }

  @Post(':id/rotate-secret')
  @HttpCode(200)
  async rotate(@Param('id', ParseUUIDPipe) id: string): Promise<InstallationCredentials> {
    const secret = randomBytes(32).toString('base64url');
    const inst = await this.prisma.db.installation.update({ where: { id }, data: { secretHash: sha256(secret) } });
    return this.credentials(inst.publicId, secret);
  }

  /** Código de activación PERMANENTE (pago único): se ingresa una vez en la instancia, con los RUC autorizados. */
  @Post(':id/activation-code')
  @HttpCode(200)
  async activationCode(@Param('id', ParseUUIDPipe) id: string, @Req() req: HubRequest) {
    const inst = await this.prisma.db.installation.findUnique({ where: { id }, include: { plan: true, client: true } });
    if (!inst) throw new NotFoundException('Instalación no encontrada');
    if (inst.status === 'CANCELLED') throw new ForbiddenException('La instalación está cancelada');
    const { token, rucs } = await this.issuer.issue(inst, { issuedBy: req.hubUserId });
    return { code: token, rucs };
  }

  private credentials(installationId: string, installationSecret: string): InstallationCredentials {
    return {
      installationId,
      installationSecret,
      envSnippet: [`HUB_URL=${hubEnv().HUB_PUBLIC_URL}`, `INSTALLATION_ID=${installationId}`, `INSTALLATION_SECRET=${installationSecret}`].join('\n'),
    };
  }
}

/** Endpoint que consultan las instancias (cada hora) para renovar su licencia. */
@Controller('v1/licenses')
export class LicenseEndpointController {
  constructor(
    private readonly prisma: HubPrisma,
    private readonly issuer: LicenseIssuer,
  ) {}

  @HubPublic()
  @Post('validate')
  @HttpCode(200)
  async validate(@Body(new ZodPipe(licenseValidateSchema)) body: LicenseValidateRequest, @Req() req: HubRequest) {
    const inst = await this.prisma.db.installation.findUnique({
      where: { publicId: body.installationId },
      include: { plan: true, client: true },
    });
    const given = Buffer.from(sha256(body.secret));
    if (!inst || !timingSafeEqual(given, Buffer.from(inst.secretHash))) {
      throw new UnauthorizedException('Credenciales de instalación inválidas');
    }
    if (inst.status === 'CANCELLED') throw new ForbiddenException('Instalación cancelada');
    await this.prisma.db.installation.update({
      where: { id: inst.id },
      data: {
        lastSeenAt: new Date(),
        lastIp: req.ip ?? null,
        appVersion: body.appVersion ?? null,
        ...(body.report ? { lastReport: body.report as Prisma.InputJsonValue } : {}),
      },
    });
    // Solo reporte de estado: se entrega la licencia permanente vigente (útil si se autorizó un RUC nuevo).
    // Una instalación suspendida o cancelada NO recibe nada que la bloquee: conserva la licencia que ya pagó.
    if (inst.status !== 'ACTIVE') return { token: null };
    const { token } = await this.issuer.issue(inst, { record: false });
    return { token };
  }
}

@Controller('hub')
export class HubHealthController {
  @HubPublic()
  @Get('health')
  health() {
    return { status: 'ok', time: new Date().toISOString() };
  }
}
