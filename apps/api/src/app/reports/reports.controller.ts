import { Controller, ForbiddenException, Get, Query, Res, StreamableFile } from '@nestjs/common';
import { ZodPipe } from '@vektra/nest-common';
import { AtsQuery, atsQuerySchema, ReportQuery, reportQuerySchema } from '@vektra/shared-contracts';
import type { Response } from 'express';
import { RequirePermissions } from '../common/decorators';
import { PrismaService } from '../common/prisma.service';
import { currentContext } from '../common/request-context';
import { AtsService } from './ats.service';
import { reportWorkbook } from './excel';
import { ReportsService } from './reports.service';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly atsService: AtsService,
    private readonly prisma: PrismaService,
  ) {}

  /** Reporte en JSON o Excel (?format=xlsx). La cartera también la ven quienes gestionan cobros. */
  @Get()
  async run(@Query(new ZodPipe(reportQuerySchema)) q: ReportQuery, @Res({ passthrough: true }) res: Response) {
    const perms = currentContext().permissions;
    if (!perms?.has('reports.read') && !(q.kind === 'receivables' && perms?.has('receivables.manage'))) {
      throw new ForbiddenException('No tiene permiso para ver reportes');
    }
    const result = await this.reports.run(q);
    if (q.format !== 'xlsx') return result;
    const tenant = await this.prisma.tx((tx) => tx.tenant.findFirstOrThrow({ select: { legalName: true, ruc: true } }));
    const buffer = await reportWorkbook(result, `${tenant.legalName} — RUC ${tenant.ruc}`);
    res.set({ 'content-type': XLSX, 'content-disposition': `attachment; filename="${q.kind}_${q.from}_${q.to}.xlsx"` });
    return new StreamableFile(buffer);
  }

  /** Revisión previa del ATS (?format=json) o archivo para el DIMM (xml) / SRI en línea (zip). */
  @Get('ats')
  @RequirePermissions('reports.tax')
  async ats(@Query(new ZodPipe(atsQuerySchema)) q: AtsQuery, @Res({ passthrough: true }) res: Response) {
    if (q.format === 'json') return (await this.atsService.generate(q)).preview;
    const file = await this.atsService.file(q);
    res.set({ 'content-type': file.type, 'content-disposition': `attachment; filename="${file.name}"` });
    return new StreamableFile(file.content);
  }
}
