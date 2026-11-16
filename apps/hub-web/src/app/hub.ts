import { HttpClient, HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { CanActivateFn, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { catchError, throwError } from 'rxjs';

const KEY = 'vk_hub_session';

interface HubSession {
  accessToken: string;
  user: { id: string; email: string; fullName: string };
}

/** Sesión del personal de Vektra (panel interno). */
@Injectable({ providedIn: 'root' })
export class HubAuth {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  readonly session = signal<HubSession | null>(this.read());

  private read(): HubSession | null {
    try {
      return JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as HubSession | null;
    } catch {
      return null;
    }
  }

  async login(email: string, password: string): Promise<void> {
    const s = await firstValueFrom(this.http.post<HubSession>('/api/hub/auth/login', { email, password }));
    this.session.set(s);
    try {
      sessionStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      /* navegación privada */
    }
  }

  logout(): void {
    this.session.set(null);
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      /* ignorar */
    }
    void this.router.navigateByUrl('/ingresar');
  }
}

export const hubInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(HubAuth);
  const token = auth.session()?.accessToken;
  const r = token ? req.clone({ setHeaders: { authorization: `Bearer ${token}` } }) : req;
  return next(r).pipe(
    catchError((err: unknown) => {
      if (err instanceof HttpErrorResponse && err.status === 401 && token) auth.logout();
      return throwError(() => err);
    }),
  );
};

export const hubAuthGuard: CanActivateFn = () => (inject(HubAuth).session() ? true : inject(Router).createUrlTree(['/ingresar']));

export function errorMessage(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) return 'Sin conexión con el Hub';
    return (err.error as { message?: string } | null)?.message ?? 'Error inesperado';
  }
  return 'Error inesperado';
}

@Injectable({ providedIn: 'root' })
export class Toast {
  private readonly snack = inject(MatSnackBar);
  ok(m: string) {
    this.snack.open(m, 'Cerrar', { duration: 3500, panelClass: 'vk-snack-ok' });
  }
  error(e: unknown) {
    this.snack.open(typeof e === 'string' ? e : errorMessage(e), 'Cerrar', { duration: 6000, panelClass: 'vk-snack-error' });
  }
}
