import { Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { HubAuth } from '../hub';

/**
 * Panel interno de Vektra. Menú lateral oscuro a propósito: así nunca se confunde con el sistema
 * que usan los clientes (menú claro).
 */
@Component({
  selector: 'hub-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatButtonModule],
  template: `
    <div class="frame">
      <aside class="side">
        <a class="brand" routerLink="/">
          <span class="mark" aria-hidden="true">V</span>
          <span><span class="name">Vektra</span> <span class="sub">Panel del proveedor</span></span>
        </a>
        <nav aria-label="Menú del panel">
          @for (i of items; track i.link) {
            <a [routerLink]="i.link" routerLinkActive="active">
              <span class="material-symbols-outlined" aria-hidden="true">{{ i.icon }}</span>{{ i.label }}
            </a>
          }
        </nav>
        <div class="me">
          <span class="who">{{ auth.session()?.user?.fullName }}</span>
          <span class="mail">{{ auth.session()?.user?.email }}</span>
          <button type="button" class="out" (click)="auth.logout()"><span class="material-symbols-outlined" aria-hidden="true">logout</span> Cerrar sesión</button>
        </div>
      </aside>
      <main class="main"><router-outlet /></main>
    </div>
  `,
  styles: `
    :host { display: block; min-height: 100vh; }
    .frame { display: grid; grid-template-columns: 248px minmax(0, 1fr); min-height: 100vh; }
    .side { position: sticky; top: 0; height: 100vh; box-sizing: border-box; display: flex; flex-direction: column; background: #10292f; color: #d3e2e3; padding: 20px 14px; }
    .brand { display: flex; align-items: center; gap: 12px; padding: 4px 8px 22px; text-decoration: none; color: #fff; }
    .mark { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 10px; background: #fff; color: #10292f; font-weight: 700; font-size: 18px; box-shadow: inset 0 -3px 0 var(--vk-amber); }
    .name { font-size: 18px; font-weight: 700; display: block; line-height: 1.1; }
    .sub { font-size: 12.5px; color: #8fb0b3; display: block; }
    nav { display: flex; flex-direction: column; gap: 2px; }
    nav a { position: relative; display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 10px; color: #c1d4d6; text-decoration: none; font-size: 14.5px; font-weight: 500; }
    nav a .material-symbols-outlined { font-size: 21px; color: #7fa3a7; }
    nav a:hover { background: rgb(255 255 255 / 6%); color: #fff; }
    nav a.active { background: rgb(255 255 255 / 10%); color: #fff; font-weight: 600; }
    nav a.active::before { content: ''; position: absolute; left: -14px; top: 10px; bottom: 10px; width: 4px; border-radius: 0 4px 4px 0; background: var(--vk-amber); }
    nav a.active .material-symbols-outlined { color: var(--vk-amber); font-variation-settings: 'FILL' 1; }
    nav a:focus-visible, .out:focus-visible { outline: 2px solid var(--vk-amber); outline-offset: 2px; }
    .me { margin-top: auto; display: flex; flex-direction: column; gap: 2px; padding: 14px 8px 0; border-top: 1px solid rgb(255 255 255 / 10%); font-size: 13px; }
    .who { color: #fff; font-weight: 600; }
    .mail { color: #8fb0b3; overflow: hidden; text-overflow: ellipsis; }
    .out { margin-top: 10px; align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; background: none; border: 1px solid rgb(255 255 255 / 18%); color: #d3e2e3; border-radius: 10px; padding: 7px 12px; font: inherit; cursor: pointer; }
    .out:hover { background: rgb(255 255 255 / 6%); }
    .out .material-symbols-outlined { font-size: 18px; }
    .main { min-width: 0; }
    @media (max-width: 860px) {
      .frame { grid-template-columns: 1fr; }
      .side { position: static; height: auto; flex-direction: row; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px; }
      .brand { padding: 0 8px 0 0; }
      .sub, .me .mail, .me .who { display: none; }
      nav { flex-direction: row; flex-wrap: wrap; }
      nav a.active::before { display: none; }
      .me { margin: 0 0 0 auto; border: 0; padding: 0; }
      .out { margin: 0; }
    }
  `,
})
export class HubShell {
  protected readonly auth = inject(HubAuth);
  protected readonly items = [
    { link: '/instalaciones', label: 'Instalaciones', icon: 'dns' },
    { link: '/clientes', label: 'Clientes', icon: 'storefront' },
    { link: '/planes', label: 'Licencias', icon: 'workspace_premium' },
  ];
}
