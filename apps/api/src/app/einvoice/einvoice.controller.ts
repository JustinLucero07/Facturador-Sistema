import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ZodPipe } from '@vektra/nest-common';
import {
  IssueInvoiceParsed,
  issueInvoiceSchema,
  MailConfigRequest,
  mailConfigSchema,
  pageQuerySchema,
  sendEmailSchema,
  testMailSchema,
} from '@vektra/shared-contracts';
import type { Response } from 'express';
import { z } from 'zod';
import { RequirePermissions } from '../common/decorators';
import { EInvoiceService } from './einvoice.service';

const listQuery = pageQuerySchema.extend({
  status: z.enum(['DRAFT', 'SIGNED', 'SENT', 'RECEIVED', 'RETURNED', 'AUTHORIZED', 'NOT_AUTHORIZED', 'CONTINGENCY']).optional(),
  search: z.string().trim().max(100).optional(),
});

@Controller('einvoice')
export class EInvoiceController {
  constructor(private readonly svc: EInvoiceService) {}

  @Get('config')
  @RequirePermissions('sales.create')
  config() {
    return this.svc.config();
  }

  @Post('invoices')
  @RequirePermissions('sales.create')
  issue(@Body(new ZodPipe(issueInvoiceSchema)) body: IssueInvoiceParsed) {
    return this.svc.issue(body);
  }

  @Get('documents')
  @RequirePermissions('einvoice.read')
  list(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.svc.list(q);
  }

  @Get('documents/:id')
  @RequirePermissions('einvoice.read')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.detail(id);
  }

  @Get('documents/:id/xml')
  @RequirePermissions('einvoice.read')
  async xml(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const { xml, fileName } = await this.svc.xml(id);
    res.set({ 'content-type': 'application/xml; charset=utf-8', 'content-disposition': `attachment; filename="${fileName}"` });
    return new StreamableFile(Buffer.from(xml, 'utf8'));
  }

  @Get('documents/:id/ride')
  @RequirePermissions('einvoice.read')
  async ride(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const { pdf, fileName } = await this.svc.ride(id);
    res.set({ 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${fileName}"` });
    return new StreamableFile(pdf);
  }

  @Post('documents/:id/retry')
  @HttpCode(200)
  @RequirePermissions('einvoice.resend')
  retry(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.retry(id);
  }

  @Post('documents/:id/email')
  @HttpCode(204)
  @RequirePermissions('einvoice.read')
  email(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(sendEmailSchema)) body: { email?: string }) {
    return this.svc.resendEmail(id, body.email);
  }

  // Firma electrónica
  @Get('certificate')
  @RequirePermissions('einvoice.read')
  certificate() {
    return this.svc.certificate();
  }

  @Post('certificate')
  @HttpCode(200)
  @RequirePermissions('einvoice.certificate')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 64 * 1024 } }))
  upload(@UploadedFile() file: { buffer: Buffer; originalname: string } | undefined, @Body('password') password: string | undefined) {
    if (!file) throw new BadRequestException({ message: 'Revise los datos ingresados', fields: { file: 'Seleccione el archivo .p12 de su firma' } });
    if (!password) throw new BadRequestException({ message: 'Revise los datos ingresados', fields: { password: 'Ingrese la contraseña de la firma' } });
    return this.svc.uploadCertificate(file.buffer, password);
  }

  // Correo SMTP
  @Get('mail-config')
  @RequirePermissions('company.read')
  mailConfig() {
    return this.svc.mailConfig();
  }

  @Put('mail-config')
  @HttpCode(204)
  @RequirePermissions('company.update')
  saveMailConfig(@Body(new ZodPipe(mailConfigSchema)) body: MailConfigRequest) {
    return this.svc.saveMailConfig(body);
  }

  @Post('mail-config/test')
  @HttpCode(204)
  @RequirePermissions('company.update')
  testMail(@Body(new ZodPipe(testMailSchema)) body: { to: string }) {
    return this.svc.testMail(body.to);
  }
}
