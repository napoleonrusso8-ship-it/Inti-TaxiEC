import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { AuthError } from '@intitaxi/auth-verifier';
import type { Request, Response } from 'express';
import { AppError, OAuthError } from './errors.js';

/**
 * Convierte errores en respuestas RFC 9457 (problem+json) sin filtrar detalles internos.
 * Los errores inesperados se registran con el request id y se responden como 500 genérico.
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  readonly #log = new Logger('Errors');

  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request & { requestId?: string }>();
    res.setHeader('Cache-Control', 'no-store');

    if (err instanceof OAuthError) {
      if (err.error === 'invalid_dpop_proof') res.setHeader('WWW-Authenticate', 'DPoP error="invalid_dpop_proof"');
      res.status(err.status).json({ error: err.error });
      return;
    }
    if (err instanceof AuthError) {
      const status = err.code === 'insufficient_user_authentication' ? 401 : 401;
      res.setHeader('WWW-Authenticate', `DPoP error="${err.code}", algs="ES256 EdDSA"`);
      this.#log.debug(`auth rechazada (${req.requestId}): ${err.message}`);
      return this.#problem(res, status, err.code, err.code === 'insufficient_user_authentication' ? 'Se requiere verificación adicional' : 'No autenticado');
    }
    if (err instanceof AppError) {
      for (const [k, v] of Object.entries(err.headers)) res.setHeader(k, v);
      return this.#problem(res, err.status, err.code, err.detail);
    }
    if (err instanceof HttpException) {
      const status = err.getStatus();
      return this.#problem(res, status, status === 404 ? 'not_found' : 'http_error', status === 404 ? 'Recurso no encontrado' : undefined);
    }
    // Errores de body-parser / http-errors (413, 400 por JSON mal formado, 415…).
    const he = err as { status?: unknown; expose?: unknown; type?: unknown };
    if (typeof he?.status === 'number' && he.status >= 400 && he.status < 500 && he.expose === true) {
      const code = he.status === 413 ? 'payload_too_large' : 'invalid_request';
      return this.#problem(res, he.status, code, he.status === 413 ? 'Cuerpo demasiado grande' : 'Petición mal formada');
    }
    this.#log.error(`error no controlado (${req.requestId}): ${(err as Error)?.stack ?? String(err)}`);
    return this.#problem(res, 500, 'internal_error', 'Error interno');
  }

  #problem(res: Response, status: number, code: string, detail?: string) {
    res.status(status).type('application/problem+json').json({ type: `urn:intitaxi:error:${code}`, title: code, status, detail });
  }
}
