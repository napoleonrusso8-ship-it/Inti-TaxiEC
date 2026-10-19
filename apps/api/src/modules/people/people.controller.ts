import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '@intitaxi/auth-verifier';
import { AccessTokenGuard, Auth, RateLimiter, tooManyRequests, type AppRequest } from '@intitaxi/nest-common';
import { PeopleService } from './people.service.js';

@Controller('v1')
export class PeopleController {
  constructor(
    @Inject(PeopleService) private readonly people: PeopleService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  @Get('trips/:id/parties')
  @UseGuards(AccessTokenGuard)
  parties(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.people.parties(auth.userId, id, req);
  }

  @Post('trips/:id/share-links')
  @HttpCode(201)
  @UseGuards(AccessTokenGuard)
  share(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.people.shareWithContact(auth.userId, id, req);
  }

  @Delete('trips/:id/share-links')
  @HttpCode(200)
  @UseGuards(AccessTokenGuard)
  unshare(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.people.revokeShareLinks(auth.userId, id, req);
  }

  @Get('companions')
  @UseGuards(AccessTokenGuard)
  list(@Auth() auth: AuthContext) {
    return this.people.listCompanions(auth.userId);
  }

  @Post('companions')
  @HttpCode(201)
  @UseGuards(AccessTokenGuard)
  save(@Req() req: AppRequest, @Auth() auth: AuthContext, @Body() body: unknown) {
    return this.people.saveCompanion(auth.userId, body, req);
  }

  @Delete('companions/:id')
  @HttpCode(204)
  @UseGuards(AccessTokenGuard)
  remove(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.people.deleteCompanion(auth.userId, id, req);
  }

  // Portal del titular: sin cuenta, por enlace firmado de un solo titular; con límite por IP.
  async #limit(req: AppRequest) {
    const rl = await this.limiter.hit(`subject-ip:${req.ip}`, 30, 600);
    if (!rl.allowed) throw tooManyRequests(rl.retryAfterSeconds);
  }

  @Get('privacy/subject/:token')
  async view(@Req() req: AppRequest, @Param('token') token: string) {
    await this.#limit(req);
    return this.people.subjectView(token, req);
  }

  @Post('privacy/subject/:token/confirm')
  @HttpCode(200)
  async confirm(@Req() req: AppRequest, @Param('token') token: string) {
    await this.#limit(req);
    return this.people.subjectConfirm(token, req);
  }

  @Post('privacy/subject/:token/delete')
  @HttpCode(200)
  async remove2(@Req() req: AppRequest, @Param('token') token: string) {
    await this.#limit(req);
    return this.people.subjectDelete(token, req);
  }
}

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Portal del titular en HTML puro (sin JavaScript): lo abre un acompañante o tercero desde el enlace del correo.
 * Los botones son formularios POST al mismo origen; todo el contenido se escapa.
 */
@Controller('p')
export class SubjectPortalController {
  constructor(
    @Inject(PeopleService) private readonly people: PeopleService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  #page(res: Response, title: string, body: string, status = 200) {
    res.status(status).type('html').setHeader('Referrer-Policy', 'no-referrer');
    res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} · Inti Taxi</title></head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`);
  }

  async #limit(req: AppRequest) {
    const rl = await this.limiter.hit(`subject-ip:${req.ip}`, 30, 600);
    if (!rl.allowed) throw tooManyRequests(rl.retryAfterSeconds);
  }

  @Get(':token')
  async view(@Req() req: AppRequest, @Param('token') token: string, @Res() res: Response) {
    await this.#limit(req);
    const v = (await this.people.subjectView(token, req).catch(() => null)) as Record<string, any> | null;
    if (!v) return this.#page(res, 'Enlace no válido', '<p>Este enlace venció o no existe.</p>', 404);
    const action = (path: string, label: string) => `<form method="post" action="/p/${esc(token)}/${path}"><button type="submit">${esc(label)}</button></form>`;
    if (v.purpose === 'companion_consent') {
      return this.#page(res, 'Guardar tus datos como acompañante', `<p>Una persona quiere guardarte como acompañante frecuente: <strong>${esc(v.givenNames)}</strong> (${esc(v.document)}).</p><p>Estado: ${esc(v.consentStatus)}</p>${action('confirm', 'Sí, autorizo')}${action('delete', 'No autorizo: borrar mis datos')}`);
    }
    return this.#page(
      res,
      'Tus datos en Inti Taxi',
      `<p>Te registraron en un viaje (${esc(v.viaje?.fecha ? new Date(v.viaje.fecha).toLocaleString('es-EC', { timeZone: 'America/Guayaquil' }) : '')}).</p>
       <ul><li>Nombre: ${esc(v.datos.givenNames)} ${esc(v.datos.familyNames)}</li><li>Identificación: ${esc(v.datos.document)}</li></ul>
       <p><strong>Finalidad:</strong> ${esc(v.finalidad)}. <strong>Conservación:</strong> ${esc(v.conservacion)}.</p>
       <p>Tienes derecho de acceso, rectificación, eliminación, oposición y portabilidad (privacidad@intitaxi.ec).</p>
       ${v.confirmado ? '<p>Ya confirmaste este registro.</p>' : action('confirm', 'Confirmo que soy yo')}
       ${action('delete', 'Pedir la eliminación de mis datos')}`,
    );
  }

  @Post(':token/confirm')
  async confirm(@Req() req: AppRequest, @Param('token') token: string, @Res() res: Response) {
    await this.#limit(req);
    await this.people.subjectConfirm(token, req);
    this.#page(res, 'Gracias', '<p>Registramos tu confirmación.</p>');
  }

  @Post(':token/delete')
  async remove(@Req() req: AppRequest, @Param('token') token: string, @Res() res: Response) {
    await this.#limit(req);
    const r = await this.people.subjectDelete(token, req);
    this.#page(res, 'Solicitud recibida', r.status === 'completed' ? '<p>Tus datos fueron eliminados.</p>' : '<p>Tu viaje está en curso o tiene un incidente abierto: eliminaremos tus datos en cuanto se cierre. Te lo confirmaremos.</p>');
  }
}
