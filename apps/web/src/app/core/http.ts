import { HttpErrorResponse, HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import type { ApiError } from '@vektra/shared-contracts';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { AuthService } from './auth.service';

const AUTH_FREE = ['/api/auth/login', '/api/auth/refresh', '/api/auth/logout'];

function withToken(req: HttpRequest<unknown>, token: string | null) {
  return token ? req.clone({ setHeaders: { authorization: `Bearer ${token}` } }) : req;
}

/** Adjunta el token y, ante un 401, renueva una vez y reintenta. */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  if (AUTH_FREE.some((p) => req.url.startsWith(p))) return next(req.clone({ withCredentials: true }));

  return next(withToken(req, auth.token())).pipe(
    catchError((err: unknown) => {
      if (!(err instanceof HttpErrorResponse) || err.status !== 401 || !auth.isAuthenticated()) return throwError(() => err);
      return from(auth.refresh()).pipe(
        switchMap((token) => {
          if (!token) {
            void auth.expire();
            return throwError(() => err);
          }
          return next(withToken(req, token));
        }),
      );
    }),
  );
};

/** Mensaje en español a partir de un error HTTP. */
export function apiMessage(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) return 'No hay conexión con el servidor. Verifique su red.';
    const body = err.error as Partial<ApiError> | null;
    if (body?.message) return body.message;
  }
  return 'Ocurrió un error inesperado';
}

export function apiFields(err: unknown): Record<string, string> {
  if (err instanceof HttpErrorResponse) return ((err.error as Partial<ApiError> | null)?.fields ?? {}) as Record<string, string>;
  return {};
}

export const authGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  return auth.isAuthenticated() ? true : inject(Router).createUrlTree(['/ingresar']);
};

export const guestGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  return auth.isAuthenticated() ? inject(Router).createUrlTree(['/']) : true;
};

export function permissionGuard(...codes: string[]): CanActivateFn {
  return () => {
    const auth = inject(AuthService);
    return auth.can(...codes) ? true : inject(Router).createUrlTree(['/']);
  };
}

export const supportGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  return auth.session()?.user.isSupport ? true : inject(Router).createUrlTree(['/']);
};
