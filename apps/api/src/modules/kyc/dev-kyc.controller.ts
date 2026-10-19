import { Body, Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { AppError, parseInput } from '@intitaxi/nest-common';
import { z } from 'zod';
import type { AppConfig } from '../../config.js';
import { CONFIG, KYC_PROVIDER } from '../../tokens.js';
import type { KycProvider } from './providers.js';
import { MockKycProvider } from './providers.js';

/**
 * SOLO DESARROLLO (DEV_TOOLS=true, prohibido en producción): hace de "proveedor KYC" para el simulador.
 * Fija la decisión y envía el webhook firmado al mismo endpoint que usaría Veriff.
 */
@Controller('v1/dev/kyc')
export class DevKycController {
  constructor(
    @Inject(KYC_PROVIDER) private readonly provider: KycProvider,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('sessions/:ref/decide')
  @HttpCode(200)
  async decide(@Param('ref') ref: string, @Body() body: unknown) {
    if (!(this.provider instanceof MockKycProvider)) throw new AppError(404, 'not_found');
    const d = parseInput(
      z.object({
        status: z.enum(['approved', 'declined', 'resubmission_requested', 'expired', 'abandoned']),
        documentNumber: z.string().max(20).optional(),
        documentType: z.enum(['ID_CARD', 'PASSPORT']).default('ID_CARD'),
        country: z.string().length(2).default('EC'),
        givenNames: z.string().max(80).optional(),
        familyNames: z.string().max(80).optional(),
        reason: z.string().max(120).optional(),
        riskScore: z.number().min(0).max(1).optional(),
      }),
      body,
    );
    const ok = await this.provider.setDecision(ref, {
      status: d.status,
      reason: d.reason,
      riskScore: d.riskScore,
      document: { number: d.documentNumber, type: d.documentType, country: d.country },
      person: { givenNames: d.givenNames, familyNames: d.familyNames },
    });
    if (!ok) throw new AppError(404, 'not_found', 'Sesión desconocida');
    const raw = JSON.stringify({ sessionRef: ref, event: 'decision' });
    const res = await fetch(`${this.config.PUBLIC_BASE_URL}/v1/webhooks/kyc/mock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-HMAC-SIGNATURE': this.provider.signWebhook(raw) },
      body: raw,
    });
    return { webhookStatus: res.status };
  }
}
