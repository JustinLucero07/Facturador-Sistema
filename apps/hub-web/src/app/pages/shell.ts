import { Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { HubAuth } from '../hub';

@Component({
  selector: 'hub-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatButtonModule],
  template: `
    <header class="bar">
      <div class="brand"><span class="mark">V</span> Vektra <strong>Hub</strong></div>
      <nav>
        <a routerLink="/instalaciones" routerLinkActive="active">Instalaciones</a>
        <a routerLink="/clientes" routerLinkActive="active">Clientes</a>
        <a routerLink="/planes" routerLinkActive="active">Planes</a>
      </nav>
      <span class="spacer"></span>
      <span class="vk-muted who">{{ auth.session()?.user?.fullName }}</span>
      <button matButton (click)="auth.logout()">Salir</button>
    </header>
    <router-outlet />
  `,
  styles: `
    .bar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 16px; padding: 0 16px; min-height: 60px; flex-wrap: wrap; background: var(--mat-sys-surface); border-bottom: 1px solid var(--mat-sys-outline-variant); }
    .brand { display: flex; align-items: center; gap: 8px; font-size: 17px; }
    .mark { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 8px; background: var(--mat-sys-primary); color: #fff; font-weight: 800; }
    nav { display: flex; gap: 4px; }
    nav a { padding: 8px 12px; border-radius: 8px; text-decoration: none; color: var(--mat-sys-on-surface-variant); font: var(--mat-sys-label-large); }
    nav a.active { background: var(--mat-sys-primary-container); color: var(--mat-sys-on-primary-container); }
    .spacer { flex: 1; }
    @media (max-width: 599px) { .who { display: none; } }
  `,
})
export class HubShell {
  protected readonly auth = inject(HubAuth);
}
