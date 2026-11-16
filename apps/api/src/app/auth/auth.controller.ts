import { Body, Controller, Get, HttpCode, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import {
  changePasswordSchema,
  disableTwoFactorSchema,
  enableTwoFactorSchema,
  LoginResponse,
  loginSchema,
  RefreshResponse,
  selectTenantSchema,
  switchTenantSchema,
  twoFactorLoginSchema,
} from '@vektra/shared-contracts';
import type { Request, Response } from 'express';
import { getEnv } from '../config/env';
import { AllowWithoutLicense, Public } from '../common/decorators';
import { currentContext } from '../common/request-context';
import { ZodPipe } from '@vektra/nest-common';
import { AuthService, LoginResult } from './auth.service';
import type { IssuedTokens } from './token.service';

const REFRESH_COOKIE = 'vk_rt';

@Controller('auth')
@AllowWithoutLicense()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body(new ZodPipe(loginSchema)) body: { email: string; password: string }, @Res({ passthrough: true }) res: Response) {
    return this.finish(await this.auth.login(body.email, body.password, this.meta()), res);
  }

  @Public()
  @Post('login/2fa')
  @HttpCode(200)
  async loginTwoFactor(@Body(new ZodPipe(twoFactorLoginSchema)) body: { challenge: string; code: string }, @Res({ passthrough: true }) res: Response) {
    return this.finish(await this.auth.loginTwoFactor(body.challenge, body.code, this.meta()), res);
  }

  @Public()
  @Post('login/tenant')
  @HttpCode(200)
  async loginTenant(@Body(new ZodPipe(selectTenantSchema)) body: { challenge: string; tenantId: string }, @Res({ passthrough: true }) res: Response) {
    return this.finish(await this.auth.loginSelectTenant(body.challenge, body.tenantId, this.meta()), res);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<RefreshResponse> {
    const raw = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (!raw) throw new UnauthorizedException();
    try {
      const issued = await this.auth.refresh(raw, this.meta());
      this.setCookie(res, issued);
      return { accessToken: issued.accessToken, expiresIn: issued.expiresIn };
    } catch (e) {
      this.clearCookie(res);
      throw e;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE]);
    this.clearCookie(res);
  }

  @Get('me')
  me() {
    return this.auth.me();
  }

  @Post('switch-tenant')
  @HttpCode(200)
  async switchTenant(@Body(new ZodPipe(switchTenantSchema)) body: { tenantId: string }, @Res({ passthrough: true }) res: Response) {
    return this.finish(await this.auth.switchTenant(body.tenantId, this.meta()), res);
  }

  @Post('change-password')
  @HttpCode(204)
  async changePassword(
    @Body(new ZodPipe(changePasswordSchema)) body: { currentPassword: string; newPassword: string },
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.changePassword(body.currentPassword, body.newPassword);
    this.clearCookie(res);
  }

  @Post('2fa/setup')
  @HttpCode(200)
  setupTwoFactor() {
    return this.auth.setupTwoFactor();
  }

  @Post('2fa/enable')
  @HttpCode(204)
  enableTwoFactor(@Body(new ZodPipe(enableTwoFactorSchema)) body: { code: string }) {
    return this.auth.enableTwoFactor(body.code);
  }

  @Post('2fa/disable')
  @HttpCode(204)
  disableTwoFactor(@Body(new ZodPipe(disableTwoFactorSchema)) body: { password: string; code: string }) {
    return this.auth.disableTwoFactor(body.password, body.code);
  }

  private meta() {
    const ctx = currentContext();
    return { ip: ctx.ip, userAgent: ctx.userAgent };
  }

  private finish(result: LoginResult, res: Response): LoginResponse {
    if (result.step !== 'done') return result;
    this.setCookie(res, result.tokens);
    return { step: 'done', accessToken: result.tokens.accessToken, expiresIn: result.tokens.expiresIn, session: result.session };
  }

  private setCookie(res: Response, tokens: IssuedTokens): void {
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
      httpOnly: true,
      secure: getEnv().NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/api/auth',
      expires: tokens.refreshExpiresAt,
    });
  }

  private clearCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
  }
}
