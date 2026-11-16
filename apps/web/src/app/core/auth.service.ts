import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { LoginResponse, RefreshResponse, SessionInfo, TenantOption } from '@vektra/shared-contracts';
import { firstValueFrom } from 'rxjs';

/**
 * Sesión del usuario. El access token vive SOLO en memoria (nunca en localStorage);
 * el refresh token es una cookie httpOnly que el navegador envía a /api/auth.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);

  private readonly accessToken = signal<string | null>(null);
  readonly session = signal<SessionInfo | null>(null);
  readonly isAuthenticated = computed(() => this.session() !== null);
  readonly permissions = computed(() => new Set(this.session()?.permissions ?? []));
  readonly tenantName = computed(() => {
    const t = this.session()?.tenant;
    return t ? (t.tradeName ?? t.legalName) : '';
  });

  private refreshing: Promise<string | null> | null = null;

  token(): string | null {
    return this.accessToken();
  }

  can(...codes: string[]): boolean {
    const perms = this.permissions();
    return codes.every((c) => perms.has(c));
  }

  hasModule(code: string): boolean {
    return this.session()?.tenant.modules.includes(code) ?? false;
  }

  login(email: string, password: string): Promise<LoginResponse> {
    return this.handle(this.http.post<LoginResponse>('/api/auth/login', { email, password }));
  }

  loginTwoFactor(challenge: string, code: string): Promise<LoginResponse> {
    return this.handle(this.http.post<LoginResponse>('/api/auth/login/2fa', { challenge, code }));
  }

  selectTenant(challenge: string, tenantId: string): Promise<LoginResponse> {
    return this.handle(this.http.post<LoginResponse>('/api/auth/login/tenant', { challenge, tenantId }));
  }

  async switchTenant(tenant: TenantOption): Promise<void> {
    await this.handle(this.http.post<LoginResponse>('/api/auth/switch-tenant', { tenantId: tenant.id }));
    await this.router.navigateByUrl('/');
  }

  /** Al cargar la app: intenta recuperar la sesión con la cookie de refresh. */
  async restore(): Promise<void> {
    const token = await this.refresh();
    if (!token) return;
    try {
      this.session.set(await firstValueFrom(this.http.get<SessionInfo>('/api/auth/me')));
    } catch {
      this.clear();
    }
  }

  async reloadSession(): Promise<void> {
    this.session.set(await firstValueFrom(this.http.get<SessionInfo>('/api/auth/me')));
  }

  /** Renueva el access token. Concurrencia: varias peticiones 401 comparten una sola renovación. */
  refresh(): Promise<string | null> {
    this.refreshing ??= firstValueFrom(this.http.post<RefreshResponse>('/api/auth/refresh', {}, { withCredentials: true }))
      .then((r) => {
        this.accessToken.set(r.accessToken);
        return r.accessToken;
      })
      .catch(() => {
        this.clear();
        return null;
      })
      .finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  async logout(): Promise<void> {
    await firstValueFrom(this.http.post('/api/auth/logout', {}, { withCredentials: true })).catch(() => undefined);
    this.clear();
    await this.router.navigateByUrl('/ingresar');
  }

  /** Sesión expirada desde el interceptor. */
  async expire(): Promise<void> {
    this.clear();
    await this.router.navigate(['/ingresar'], { queryParams: { expirada: 1 } });
  }

  private clear(): void {
    this.accessToken.set(null);
    this.session.set(null);
  }

  private async handle(request: ReturnType<HttpClient['post']> & object): Promise<LoginResponse> {
    const res = (await firstValueFrom(request)) as LoginResponse;
    if (res.step === 'done') {
      this.accessToken.set(res.accessToken);
      this.session.set(res.session);
    }
    return res;
  }
}
