import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import {
  ALLOW_WITHOUT_LICENSE,
  IS_PUBLIC,
  REQUIRED_PERMISSIONS,
  SUPPORT_ONLY,
} from '../common/decorators';
import { currentContext } from '../common/request-context';
import { LicenseService } from '../license/license.service';
import { SessionService } from './session.service';
import type { AccessTokenPayload } from './token.service';

/**
 * Guard global: autentica (JWT), carga permisos, llena el contexto de la solicitud,
 * verifica permisos requeridos y bloquea escrituras si la licencia no es válida.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly sessions: SessionService,
    private readonly license: LicenseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new UnauthorizedException();

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token);
    } catch {
      throw new UnauthorizedException();
    }
    if (payload.typ !== 'access') throw new UnauthorizedException();

    const session = await this.sessions.load(payload.sub, payload.tid, payload.ver);
    const ctx = currentContext();
    ctx.userId = session.userId;
    ctx.tenantId = session.tenantId;
    ctx.membershipId = session.membershipId;
    ctx.isSupport = session.isSupport;
    ctx.permissions = session.permissions;

    if (this.reflector.getAllAndOverride<boolean>(SUPPORT_ONLY, targets) && !session.isSupport) {
      throw new ForbiddenException('Solo el personal de Soporte Vektra puede realizar esta acción');
    }

    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMISSIONS, targets) ?? [];
    const missing = required.filter((p) => !session.permissions.has(p));
    if (missing.length > 0) throw new ForbiddenException('No tiene permiso para realizar esta acción');

    const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (isWrite && !session.isSupport && !this.reflector.getAllAndOverride<boolean>(ALLOW_WITHOUT_LICENSE, targets)) {
      if (!(await this.license.canWrite())) {
        const status = await this.license.status();
        throw new ForbiddenException(`${status.message} El sistema está en modo solo lectura.`);
      }
    }
    return true;
  }
}
