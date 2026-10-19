import { Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { KycService } from '../kyc/kyc.service.js';
import { MatchingService } from '../trips/matching.service.js';
import { PeopleService } from '../people/people.service.js';

/** SOLO DESARROLLO (DEV_TOOLS): ejecuta tareas periódicas a demanda para el simulador y las pruebas. */
@Controller('v1/dev')
export class DevJobsController {
  constructor(
    @Inject(PeopleService) private readonly people: PeopleService,
    @Inject(KycService) private readonly kyc: KycService,
    @Inject(MatchingService) private readonly matching: MatchingService,
  ) {}

  @Post('retention/run')
  @HttpCode(200)
  async retention() {
    return { anonymizedPeople: await this.people.purgeExpired(), kycProviderDeletions: await this.kyc.purgeProviderData() };
  }

  @Post('matching/sweep')
  @HttpCode(200)
  async sweep() {
    await this.matching.sweep();
    return { ok: true };
  }
}
