import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { ApiError } from '@vektra/shared-contracts';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import type { Response } from 'express';

/** Normaliza todos los errores al formato ApiError con mensajes en español. */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpError');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const body = this.toApiError(exception);
    if (body.statusCode >= 500) this.logger.error(exception instanceof Error ? exception.stack : exception);
    res.status(body.statusCode).json(body);
  }

  private toApiError(exception: unknown): ApiError {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      if (typeof response === 'object' && response !== null) {
        const r = response as { message?: string | string[]; fields?: Record<string, string> };
        const message = Array.isArray(r.message) ? r.message.join(', ') : r.message;
        return { statusCode: status, message: this.translate(status, message), ...(r.fields ? { fields: r.fields } : {}) };
      }
      return { statusCode: status, message: this.translate(status, String(response)) };
    }
    if (exception instanceof PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') return { statusCode: HttpStatus.CONFLICT, message: 'Ya existe un registro con esos datos' };
      if (exception.code === 'P2025') return { statusCode: HttpStatus.NOT_FOUND, message: 'Registro no encontrado' };
      if (exception.code === 'P2003') return { statusCode: HttpStatus.CONFLICT, message: 'El registro está siendo usado por otros datos' };
    }
    return { statusCode: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Ocurrió un error inesperado. Intente nuevamente.' };
  }

  /** Mensajes por defecto de Nest (en inglés) → español. */
  private translate(status: number, message: string | undefined): string {
    const defaults: Record<number, string> = {
      400: 'Solicitud inválida',
      401: 'Su sesión ha expirado. Inicie sesión nuevamente.',
      403: 'No tiene permiso para realizar esta acción',
      404: 'Recurso no encontrado',
      409: 'Conflicto con datos existentes',
      423: 'Recurso bloqueado',
      429: 'Demasiadas solicitudes, espere un momento',
    };
    if (!message || /^(Bad Request|Unauthorized|Forbidden|Not Found|Conflict|Cannot (GET|POST|PATCH|PUT|DELETE))/.test(message)) {
      return defaults[status] ?? 'Error en la solicitud';
    }
    return message;
  }
}
