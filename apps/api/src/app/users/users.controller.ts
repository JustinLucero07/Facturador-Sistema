import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import {
  CreateUserRequest,
  createUserSchema,
  resetPasswordSchema,
  UpdateUserRequest,
  updateUserSchema,
} from '@vektra/shared-contracts';
import { RequirePermissions } from '../common/decorators';
import { ZodPipe } from '@vektra/nest-common';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermissions('users.read')
  list() {
    return this.users.list();
  }

  @Post()
  @RequirePermissions('users.manage')
  create(@Body(new ZodPipe(createUserSchema)) body: CreateUserRequest) {
    return this.users.create(body);
  }

  @Patch(':membershipId')
  @HttpCode(204)
  @RequirePermissions('users.manage')
  update(@Param('membershipId', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateUserSchema)) body: UpdateUserRequest) {
    return this.users.update(id, body);
  }

  @Post(':membershipId/reset-password')
  @HttpCode(204)
  @RequirePermissions('users.manage')
  resetPassword(@Param('membershipId', ParseUUIDPipe) id: string, @Body(new ZodPipe(resetPasswordSchema)) body: { newPassword: string }) {
    return this.users.resetPassword(id, body.newPassword);
  }

  @Post(':membershipId/unlock')
  @HttpCode(204)
  @RequirePermissions('users.manage')
  unlock(@Param('membershipId', ParseUUIDPipe) id: string) {
    return this.users.unlock(id);
  }
}
