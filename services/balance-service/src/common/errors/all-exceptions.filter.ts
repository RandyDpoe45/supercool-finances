import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { RequestWithIdentity } from '../identity/request-identity';
import { codeForStatus, ErrorResponse } from './error-response';

/**
 * Global exception filter that renders every failure as the single {@link
 * ErrorResponse} shape. 5xx messages are made generic so internal details never
 * leak to clients; the full error is logged server-side with the request id.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<RequestWithIdentity>();
    const response = ctx.getResponse<Response>();
    const requestId = request.requestId ?? 'unknown';

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'Internal server error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = codeForStatus(status);
      message = extractMessage(exception.getResponse()) ?? exception.message;
    }

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      // Never leak internals on a 5xx — log the real cause, return a generic message.
      this.logger.error(
        `[${requestId}] ${request.method} ${request.url} -> ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
      message =
        status === HttpStatus.SERVICE_UNAVAILABLE ? 'Service unavailable' : 'Internal server error';
    }

    const body: ErrorResponse = { error: { code, message, requestId } };
    response.status(status).json(body);
  }
}

function extractMessage(payload: string | object): string | undefined {
  if (typeof payload === 'string') {
    return payload;
  }
  const message = (payload as { message?: string | string[] }).message;
  if (Array.isArray(message)) {
    return message.join(', ');
  }
  return message;
}
