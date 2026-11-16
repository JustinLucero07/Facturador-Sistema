import { registerLocaleData } from '@angular/common';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import localeEsEc from '@angular/common/locales/es-EC';
import {
  ApplicationConfig,
  DEFAULT_CURRENCY_CODE,
  inject,
  LOCALE_ID,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { MAT_FORM_FIELD_DEFAULT_OPTIONS } from '@angular/material/form-field';
import { MatPaginatorIntl } from '@angular/material/paginator';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { appRoutes } from './app.routes';
import { RuntimeService } from './core/runtime';
import { AuthService } from './core/auth.service';
import { authInterceptor } from './core/http';

registerLocaleData(localeEsEc);

function spanishPaginator(): MatPaginatorIntl {
  const intl = new MatPaginatorIntl();
  intl.itemsPerPageLabel = 'Filas por página';
  intl.nextPageLabel = 'Siguiente';
  intl.previousPageLabel = 'Anterior';
  intl.firstPageLabel = 'Primera página';
  intl.lastPageLabel = 'Última página';
  intl.getRangeLabel = (page, size, length) => {
    if (length === 0) return '0 de 0';
    const start = page * size;
    return `${start + 1} – ${Math.min(start + size, length)} de ${length}`;
  };
  return intl;
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(appRoutes, withComponentInputBinding()),
    provideHttpClient(withInterceptors([authInterceptor])),
    { provide: LOCALE_ID, useValue: 'es-EC' },
    { provide: DEFAULT_CURRENCY_CODE, useValue: 'USD' },
    { provide: MatPaginatorIntl, useFactory: spanishPaginator },
    { provide: MAT_FORM_FIELD_DEFAULT_OPTIONS, useValue: { appearance: 'outline', subscriptSizing: 'dynamic' } },
    // Recuperar la sesión (cookie de refresh) antes de resolver la primera ruta.
    // Modo (web o caja de escritorio) y sesión (cookie de refresh) antes de resolver la primera ruta.
    provideAppInitializer(async () => {
      const runtime = inject(RuntimeService);
      const auth = inject(AuthService);
      await runtime.load();
      await auth.restore();
    }),
  ],
};
