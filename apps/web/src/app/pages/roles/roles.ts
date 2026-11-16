import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import type { PermissionGroup, RoleItem } from '@vektra/shared-contracts';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth.service';
import { Notify } from '../../core/notify.service';

interface Draft {
  id: string | null;
  name: string;
  description: string;
  permissions: Set<string>;
  isSystem: boolean;
  systemCode: string | null;
}

@Component({
  selector: 'vk-roles',
  imports: [FormsModule, MatButtonModule, MatCheckboxModule, MatFormFieldModule, MatInputModule],
  templateUrl: './roles.html',
  styleUrl: './roles.scss',
})
export class RolesPage implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly notify = inject(Notify);
  protected readonly auth = inject(AuthService);

  protected readonly roles = signal<RoleItem[]>([]);
  protected readonly groups = signal<PermissionGroup[]>([]);
  protected readonly draft = signal<Draft | null>(null);
  protected readonly saving = signal(false);
  protected readonly canManage = computed(() => this.auth.can('roles.manage'));
  protected readonly isAdminRole = computed(() => this.draft()?.systemCode === 'ADMIN');

  async ngOnInit(): Promise<void> {
    const [roles, groups] = await Promise.all([
      firstValueFrom(this.http.get<RoleItem[]>('/api/roles')),
      firstValueFrom(this.http.get<PermissionGroup[]>('/api/permissions')),
    ]);
    this.roles.set(roles);
    this.groups.set(groups);
    if (roles.length) this.select(roles[0]);
  }

  protected select(r: RoleItem): void {
    this.draft.set({ id: r.id, name: r.name, description: r.description ?? '', permissions: new Set(r.permissions), isSystem: r.isSystem, systemCode: r.systemCode });
  }

  protected create(): void {
    this.draft.set({ id: null, name: '', description: '', permissions: new Set(), isSystem: false, systemCode: null });
  }

  protected has(code: string): boolean {
    return this.draft()?.permissions.has(code) ?? false;
  }

  protected toggle(code: string, checked: boolean): void {
    const d = this.draft();
    if (!d) return;
    const next = new Set(d.permissions);
    if (checked) next.add(code);
    else next.delete(code);
    this.draft.set({ ...d, permissions: next });
  }

  protected groupState(g: PermissionGroup): 'all' | 'some' | 'none' {
    const n = g.permissions.filter((p) => this.has(p.code)).length;
    return n === 0 ? 'none' : n === g.permissions.length ? 'all' : 'some';
  }

  protected toggleGroup(g: PermissionGroup, checked: boolean): void {
    for (const p of g.permissions) this.toggle(p.code, checked);
  }

  protected setName(name: string): void {
    const d = this.draft();
    if (d) this.draft.set({ ...d, name });
  }

  protected setDescription(description: string): void {
    const d = this.draft();
    if (d) this.draft.set({ ...d, description });
  }

  protected async save(): Promise<void> {
    const d = this.draft();
    if (!d || !d.name.trim()) return this.notify.error('Ingrese el nombre del rol');
    this.saving.set(true);
    const body = { name: d.name.trim(), description: d.description.trim() || null, permissions: [...d.permissions] };
    try {
      if (d.id) await firstValueFrom(this.http.patch(`/api/roles/${d.id}`, body));
      else d.id = (await firstValueFrom(this.http.post<{ id: string }>('/api/roles', body))).id;
      this.notify.ok('Rol guardado');
      this.roles.set(await firstValueFrom(this.http.get<RoleItem[]>('/api/roles')));
      const saved = this.roles().find((r) => r.id === d.id);
      if (saved) this.select(saved);
      await this.auth.reloadSession();
    } catch (e) {
      this.notify.error(e);
    } finally {
      this.saving.set(false);
    }
  }

  protected async remove(): Promise<void> {
    const d = this.draft();
    if (!d?.id) return;
    const ok = await this.notify.confirm({ title: 'Eliminar rol', message: `¿Eliminar el rol "${d.name}"?`, confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try {
      await firstValueFrom(this.http.delete(`/api/roles/${d.id}`));
      this.notify.ok('Rol eliminado');
      this.roles.set(await firstValueFrom(this.http.get<RoleItem[]>('/api/roles')));
      this.draft.set(null);
    } catch (e) {
      this.notify.error(e);
    }
  }
}
