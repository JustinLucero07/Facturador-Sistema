import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Side } from '@vektra/accounts';
import { ZodPipe } from '@vektra/nest-common';
import {
  accountPaymentSchema,
  AccountPaymentParsed,
  applyCreditSchema,
  openingItemSchema,
  pageQuerySchema,
  receivedWithholdingSchema,
  ReceivedWithholdingParsed,
  voidAccountMovementSchema,
} from '@vektra/shared-contracts';
import { z } from 'zod';
import { currentContext } from '../common/request-context';
import { AccountsService } from './accounts.service';

const overviewQuery = pageQuerySchema.extend({ search: z.string().trim().max(100).optional(), overdue: z.enum(['true', 'false']).optional() });

/** AR (por cobrar) requiere receivables.manage; AP (por pagar) requiere purchases.manage. */
function sideOf(raw: string): Side {
  const side = raw.toUpperCase();
  if (side !== 'AR' && side !== 'AP') throw new BadRequestException('Use AR (por cobrar) o AP (por pagar)');
  const perms = currentContext().permissions;
  const need = side === 'AR' ? 'receivables.manage' : 'purchases.manage';
  if (!perms?.has(need)) throw new ForbiddenException('No tiene permiso para realizar esta acción');
  return side;
}

@Controller('accounts')
export class AccountsController {
  constructor(private readonly svc: AccountsService) {}

  @Get(':side')
  overview(@Param('side') side: string, @Query(new ZodPipe(overviewQuery)) q: z.output<typeof overviewQuery>) {
    return this.svc.overview(sideOf(side), { ...q, overdueOnly: q.overdue === 'true' });
  }

  @Get(':side/parties/:partyId')
  statement(@Param('side') side: string, @Param('partyId', ParseUUIDPipe) partyId: string) {
    return this.svc.statement(sideOf(side), partyId);
  }

  @Post(':side/payments')
  payment(@Param('side') side: string, @Body(new ZodPipe(accountPaymentSchema)) body: AccountPaymentParsed) {
    return this.svc.registerPayment(sideOf(side), body);
  }

  @Post(':side/openings')
  opening(@Param('side') side: string, @Body(new ZodPipe(openingItemSchema)) body: z.output<typeof openingItemSchema>) {
    return this.svc.createOpening(sideOf(side), body);
  }

  @Post(':side/apply-credit')
  @HttpCode(204)
  async applyCredit(@Param('side') side: string, @Body(new ZodPipe(applyCreditSchema)) body: z.output<typeof applyCreditSchema>) {
    sideOf(side);
    await this.svc.applyCredit(body);
  }

  @Post(':side/movements/:id/void')
  @HttpCode(204)
  async voidMovement(@Param('side') side: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(voidAccountMovementSchema)) body: { reason: string }) {
    sideOf(side);
    await this.svc.voidMovement(id, body.reason);
  }

  /** Retenciones que le hacen sus clientes */
  @Post('AR/withholdings/xml-preview')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 1024 * 1024 } }))
  withholdingPreview(@UploadedFile() file: { buffer: Buffer } | undefined) {
    sideOf('AR');
    if (!file) throw new BadRequestException('Seleccione el XML del comprobante de retención');
    return this.svc.receivedWithholdingPreview(file.buffer.toString('utf8'));
  }

  @Post('AR/withholdings')
  withholding(@Body(new ZodPipe(receivedWithholdingSchema)) body: ReceivedWithholdingParsed) {
    sideOf('AR');
    return this.svc.registerReceivedWithholding(body);
  }
}
