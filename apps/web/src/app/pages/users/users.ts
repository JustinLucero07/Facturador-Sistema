import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, inject, OnInit, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatMenuModule } from '@angular/material/menu';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import type { EstablishmentItem, RoleItem, UserListItem } from '@vektra/shared-contracts';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth.service';
import { Notify } from '../../core/notify.service';
import { PasswordDialog } from './password-dialog';
import { UserDialog, UserDialogData } from './user-dialog';

@Component({
  selector: 'vk-users',
  imports: [MatTableModule, MatButtonModule, MatMenuModule, MatTooltipModule, DatePipe],
  templateUrl: './users.html',
})
export class UsersPage implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(Notify);
  protected readonly auth = inject(AuthService);

  protected readonly users = signal<UserListItem[]>([]);
  protected readonly loading = signal(true);
  protected readonly columns = ['name', 'roles', 'status', 'lastLogin', 'actions'];
  private roles: RoleItem[] = [];
  private establishments: EstablishmentItem[] = [];

  async ngOnInit(): Promise<void> {
    await this.load();
    if (this.auth.can('users.manage')) {
      [this.roles, this.establishments] = await Promise.all([
        firstValueFrom(this.http.get<RoleItem[]>('/api/roles')).catch(() => []),
        firstValueFrom(this.http.get<EstablishmentItem[]>('/api/establishments')).catch(() => []),
      ]);
    }
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.users.set(await firstValueFrom(this.http.get<UserListItem[]>('/api/users')));
    } catch (e) {
      this.notify.error(e);
    } finally {
      this.loading.set(false);
    }
  }

  protected open(user?: UserListItem): void {
    const data: UserDialogData = { user, roles: this.roles, establishments: this.establishments };
    this.dialog
      .open(UserDialog, { data, panelClass: 'vk-dialog' })
      .afterClosed()
      .subscribe((saved) => saved && this.load());
  }

  protected async toggleActive(u: UserListItem): Promise<void> {
    if (u.active) {
      const ok = await this.notify.confirm({
        title: 'Desactivar usuario',
        message: `${u.fullName} ya no podrá ingresar a esta empresa. Sus sesiones abiertas se cerrarán.`,
        confirmLabel: 'Desactivar',
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await firstValueFrom(this.http.patch(`/api/users/${u.membershipId}`, { active: !u.active }));
      this.notify.ok(u.active ? 'Usuario desactivado' : 'Usuario activado');
      await this.load();
    } catch (e) {
      this.notify.error(e);
    }
  }

  protected resetPassword(u: UserListItem): void {
    this.dialog.open(PasswordDialog, { data: u, panelClass: 'vk-dialog' });
  }

  protected async unlock(u: UserListItem): Promise<void> {
    try {
      await firstValueFrom(this.http.post(`/api/users/${u.membershipId}/unlock`, {}));
      this.notify.ok('Usuario desbloqueado');
      await this.load();
    } catch (e) {
      this.notify.error(e);
    }
  }
}
