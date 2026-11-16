import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { hash, verify as verifyHash } from '@node-rs/argon2';
import { decryptSecret, encryptSecret, User } from '@vektra/db';
import type { LoginResponse, SessionInfo, TenantOption, TwoFactorSetupResponse } from '@vektra/shared-contracts';
import { generateSecret, generateURI, verify as verifyTotp } from 'otplib';
import { toDataURL } from 'qrcode';
import { AuditService } from '../audit/audit.service';
import { getEnv } from '../config/env';
import { PrismaService } from '../common/prisma.service';
import { currentContext } from '../common/request-context';
import { SessionService } from './session.service';
import { IssuedTokens, TokenService } from './token.service';

type Meta = { ip: string | null; userAgent: string | null };
export type LoginResult =
  | { step: 'done'; tokens: IssuedTokens; session: SessionInfo }
  | Exclude<LoginResponse, { step: 'done' }>;

const INVALID_CREDENTIALS = 'Correo o contraseña incorrectos';
// Hash real de una contraseña aleatoria: igualar el tiempo de respuesta cuando el usuario no existe.
const DUMMY_HASH = hash('vektra-dummy-password-for-timing');

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  // ───────────── Login ─────────────

  async login(email: string, password: string, meta: Meta): Promise<LoginResult> {
    const user = await this.prisma.client.user.findUnique({ where: { email } });
    if (!user) {
      await verifyHash(await DUMMY_HASH, password).catch(() => false);
      await this.audit.recordStandalone(null, null, { action: 'login.failed', entity: 'user', after: { email, reason: 'unknown_user' } });
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    this.assertNotLocked(user);
    if (!user.active) throw new UnauthorizedException('Su usuario está desactivado. Comuníquese con el administrador.');

    if (!(await verifyHash(user.passwordHash, password))) {
      await this.registerFailure(user, 'bad_password');
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    if (user.totpEnabled) {
      return { step: '2fa', challenge: await this.tokens.signChallenge({ typ: '2fa', sub: user.id }) };
    }
    return this.afterPrimaryAuth(user, meta);
  }

  async loginTwoFactor(challenge: string, code: string, meta: Meta): Promise<LoginResult> {
    const { sub } = await this.tokens.verifyChallenge(challenge, '2fa');
    const user = await this.prisma.client.user.findUnique({ where: { id: sub } });
    if (!user || !user.active || !user.totpEnabled || !user.totpSecretEnc) throw new UnauthorizedException();
    this.assertNotLocked(user);
    if (!(await this.checkTotp(user.totpSecretEnc, code))) {
      await this.registerFailure(user, 'bad_2fa');
      throw new UnauthorizedException('Código de verificación incorrecto');
    }
    return this.afterPrimaryAuth(user, meta);
  }

  async loginSelectTenant(challenge: string, tenantId: string, meta: Meta): Promise<LoginResult> {
    const { sub } = await this.tokens.verifyChallenge(challenge, 'tenant');
    const user = await this.prisma.client.user.findUnique({ where: { id: sub } });
    if (!user || !user.active) throw new UnauthorizedException();
    const options = await this.tenantOptions(user);
    if (!options.some((t) => t.id === tenantId)) throw new ForbiddenException('No tiene acceso a esa empresa');
    return this.complete(user, tenantId, meta);
  }

  async switchTenant(tenantId: string, meta: Meta) {
    const ctx = currentContext();
    const user = await this.prisma.client.user.findUniqueOrThrow({ where: { id: ctx.userId } });
    const options = await this.tenantOptions(user);
    if (!options.some((t) => t.id === tenantId)) throw new ForbiddenException('No tiene acceso a esa empresa');
    return this.complete(user, tenantId, meta);
  }

  async refresh(rawRefresh: string, meta: Meta) {
    const result = await this.tokens.rotate(rawRefresh, meta);
    if (result.reused) {
      await this.audit.recordStandalone(result.tenantId, result.userId, {
        action: 'token.reuse_detected',
        entity: 'session',
        after: { ip: meta.ip },
      });
      throw new UnauthorizedException('Su sesión fue cerrada por seguridad. Inicie sesión nuevamente.');
    }
    return result.issued;
  }

  async logout(rawRefresh: string | undefined): Promise<void> {
    if (rawRefresh) await this.tokens.revokeByRaw(rawRefresh);
  }

  // ───────────── Sesión ─────────────

  async me(): Promise<SessionInfo> {
    const ctx = currentContext();
    const user = await this.prisma.client.user.findUniqueOrThrow({ where: { id: ctx.userId } });
    return this.buildSession(user, ctx.tenantId as string);
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const ctx = currentContext();
    const user = await this.prisma.client.user.findUniqueOrThrow({ where: { id: ctx.userId } });
    if (!(await verifyHash(user.passwordHash, currentPassword))) {
      throw new BadRequestException({ message: 'Revise los datos ingresados', fields: { currentPassword: 'La contraseña actual es incorrecta' } });
    }
    await this.prisma.client.user.update({
      where: { id: user.id },
      data: { passwordHash: await hash(newPassword), tokenVersion: { increment: 1 } },
    });
    await this.tokens.revokeAllForUser(user.id);
    this.sessions.invalidateUser(user.id);
    await this.audit.recordStandalone(ctx.tenantId ?? null, user.id, { action: 'password.changed', entity: 'user', entityId: user.id });
  }

  // ───────────── 2FA ─────────────

  async setupTwoFactor(): Promise<TwoFactorSetupResponse> {
    const ctx = currentContext();
    const user = await this.prisma.client.user.findUniqueOrThrow({ where: { id: ctx.userId } });
    if (user.totpEnabled) throw new BadRequestException('La verificación en dos pasos ya está activa');
    const secret = generateSecret();
    await this.prisma.client.user.update({
      where: { id: user.id },
      data: { totpSecretEnc: encryptSecret(secret, getEnv().MASTER_KEY) },
    });
    const otpauthUrl = generateURI({ issuer: 'Vektra POS', label: user.email, secret });
    return { otpauthUrl, qrDataUrl: await toDataURL(otpauthUrl), secret };
  }

  async enableTwoFactor(code: string): Promise<void> {
    const ctx = currentContext();
    const user = await this.prisma.client.user.findUniqueOrThrow({ where: { id: ctx.userId } });
    if (!user.totpSecretEnc) throw new BadRequestException('Primero genere el código QR');
    if (!(await this.checkTotp(user.totpSecretEnc, code))) throw new BadRequestException('Código incorrecto. Verifique la hora de su celular.');
    await this.prisma.client.user.update({ where: { id: user.id }, data: { totpEnabled: true } });
    await this.audit.recordStandalone(ctx.tenantId ?? null, user.id, { action: '2fa.enabled', entity: 'user', entityId: user.id });
  }

  async disableTwoFactor(password: string, code: string): Promise<void> {
    const ctx = currentContext();
    const user = await this.prisma.client.user.findUniqueOrThrow({ where: { id: ctx.userId } });
    if (!user.totpEnabled || !user.totpSecretEnc) throw new BadRequestException('La verificación en dos pasos no está activa');
    if (!(await verifyHash(user.passwordHash, password)) || !(await this.checkTotp(user.totpSecretEnc, code))) {
      throw new BadRequestException('Contraseña o código incorrectos');
    }
    await this.prisma.client.user.update({ where: { id: user.id }, data: { totpEnabled: false, totpSecretEnc: null } });
    await this.audit.recordStandalone(ctx.tenantId ?? null, user.id, { action: '2fa.disabled', entity: 'user', entityId: user.id });
  }

  // ───────────── Internos ─────────────

  private async afterPrimaryAuth(user: User, meta: Meta): Promise<LoginResult> {
    const options = await this.tenantOptions(user);
    if (options.length === 0) throw new ForbiddenException('Su usuario no tiene empresas asignadas');
    if (options.length === 1) return this.complete(user, options[0].id, meta);
    return { step: 'tenant', challenge: await this.tokens.signChallenge({ typ: 'tenant', sub: user.id }), tenants: options };
  }

  private async complete(user: User, tenantId: string, meta: Meta): Promise<LoginResult> {
    await this.prisma.client.user.update({
      where: { id: user.id },
      data: { failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    const tokens = await this.tokens.issue(user, tenantId, meta);
    await this.audit.recordStandalone(tenantId, user.id, { action: 'login.success', entity: 'session', after: { ip: meta.ip } });
    return { step: 'done', tokens, session: await this.buildSession(user, tenantId) };
  }

  private async tenantOptions(user: User): Promise<TenantOption[]> {
    if (user.isSupport) {
      const all = await this.prisma.client.tenant.findMany({ orderBy: { legalName: 'asc' } });
      return all.map((t) => ({ id: t.id, ruc: t.ruc, name: t.tradeName ?? t.legalName }));
    }
    const memberships = await this.prisma.as({ userId: user.id }, (tx) =>
      tx.membership.findMany({ where: { userId: user.id, active: true }, include: { tenant: true } }),
    );
    return memberships
      .filter((m) => m.tenant.status === 'ACTIVE')
      .map((m) => ({ id: m.tenant.id, ruc: m.tenant.ruc, name: m.tenant.tradeName ?? m.tenant.legalName }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }

  private async buildSession(user: User, tenantId: string): Promise<SessionInfo> {
    const loaded = await this.sessions.load(user.id, tenantId, user.tokenVersion);
    const tenant = await this.prisma.client.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const modules = await this.prisma.as({ tenantId, userId: user.id }, (tx) =>
      tx.tenantModule.findMany({ where: { tenantId, enabled: true } }),
    );
    return {
      user: { id: user.id, email: user.email, fullName: user.fullName, isSupport: user.isSupport, totpEnabled: user.totpEnabled },
      tenant: {
        id: tenant.id,
        ruc: tenant.ruc,
        legalName: tenant.legalName,
        tradeName: tenant.tradeName,
        environment: tenant.environment,
        modules: modules.map((m) => m.moduleCode),
      },
      permissions: [...loaded.permissions].sort(),
      tenants: await this.tenantOptions(user),
    };
  }

  private assertNotLocked(user: User): void {
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const time = user.lockedUntil.toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Guayaquil' });
      throw new HttpException(
        { message: `Cuenta bloqueada por intentos fallidos. Intente nuevamente después de las ${time}.` },
        HttpStatus.LOCKED,
      );
    }
  }

  private async registerFailure(user: User, reason: string): Promise<void> {
    const env = getEnv();
    const attempts = user.failedAttempts + 1;
    const lock = attempts >= env.AUTH_MAX_FAILED_ATTEMPTS;
    await this.prisma.client.user.update({
      where: { id: user.id },
      data: lock
        ? { failedAttempts: 0, lockedUntil: new Date(Date.now() + env.AUTH_LOCK_MINUTES * 60_000) }
        : { failedAttempts: attempts },
    });
    await this.audit.recordStandalone(null, user.id, {
      action: lock ? 'login.locked' : 'login.failed',
      entity: 'user',
      entityId: user.id,
      after: { reason, attempts },
    });
  }

  private async checkTotp(secretEnc: string, code: string): Promise<boolean> {
    const secret = decryptSecret(secretEnc, getEnv().MASTER_KEY);
    const result = await verifyTotp({ secret, token: code, epochTolerance: 30 });
    return result.valid;
  }
}
