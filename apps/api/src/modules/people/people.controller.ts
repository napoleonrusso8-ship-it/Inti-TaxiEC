import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
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
