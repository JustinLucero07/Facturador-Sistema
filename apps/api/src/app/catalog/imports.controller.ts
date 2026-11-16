import { BadRequestException, Controller, ForbiddenException, Get, HttpCode, Param, ParseUUIDPipe, Post, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { ImportKind } from '@vektra/shared-contracts';
import type { Response } from 'express';
import { RequirePermissions } from '../common/decorators';
import { currentContext } from '../common/request-context';
import { ImportsService } from './imports.service';

const KINDS: ImportKind[] = ['products', 'parties', 'initial_stock'];
/** Permiso necesario para importar cada tipo */
const PERMISSION: Record<ImportKind, string> = { products: 'catalog.manage', parties: 'customers.manage', initial_stock: 'inventory.adjust' };

function kindOf(raw: string): ImportKind {
  if (!KINDS.includes(raw as ImportKind)) throw new BadRequestException('Tipo de importación desconocido');
  const kind = raw as ImportKind;
  if (!currentContext().permissions?.has(PERMISSION[kind])) throw new ForbiddenException('No tiene permiso para esta importación');
  return kind;
}

@Controller('imports')
export class ImportsController {
  constructor(private readonly svc: ImportsService) {}

  @Get()
  @RequirePermissions('catalog.read')
  history() {
    return this.svc.history();
  }

  @Get('templates/:kind')
  async template(@Param('kind') kind: string, @Res({ passthrough: true }) res: Response) {
    const { buffer, fileName } = await this.svc.template(kindOf(kind));
    res.set({
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="${fileName}"`,
    });
    return new StreamableFile(buffer);
  }

  @Post(':kind/preview')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  preview(@Param('kind') kind: string, @UploadedFile() file: { buffer: Buffer; originalname: string } | undefined) {
    const k = kindOf(kind);
    if (!file) throw new BadRequestException('Seleccione el archivo Excel (.xlsx)');
    return this.svc.preview(k, file.originalname, file.buffer);
  }

  @Post(':id/commit')
  @HttpCode(200)
  @RequirePermissions('catalog.read')
  commit(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.commit(id);
  }
}
