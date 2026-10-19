import { type DynamicModule, Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '@intitaxi/nest-common';
import type { AppConfig } from '../../config.js';
import { PAYMENT_GATEWAY } from '../../tokens.js';
import { FraudService } from './fraud.service.js';
import { KushkiGateway, MockGateway } from './gateway.js';
import { AdminPaymentsController, DevPaymentsController, PaymentsController, PaymentsWebhookController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
import { PayoutsService } from './payouts.service.js';

@Module({})
export class PaymentsModule {
  static forConfig(c: AppConfig): DynamicModule {
    return {
      module: PaymentsModule,
      global: true,
      controllers: [PaymentsController, AdminPaymentsController, PaymentsWebhookController, ...(c.DEV_TOOLS ? [DevPaymentsController] : [])],
      providers: [
        {
          provide: PAYMENT_GATEWAY,
          inject: [REDIS],
          useFactory: (r: Redis) =>
            c.PAYMENT_GATEWAY === 'kushki'
              ? new KushkiGateway({ baseUrl: c.KUSHKI_BASE_URL, privateMerchantId: c.KUSHKI_PRIVATE_MERCHANT_ID!, webhookSecret: c.KUSHKI_WEBHOOK_SECRET! })
              : new MockGateway(r, Buffer.from(c.WEBHOOK_SECRET_PAYMENTS!, 'base64'), c.PUBLIC_BASE_URL),
        },
        FraudService,
        PaymentsService,
        PayoutsService,
      ],
      exports: [PaymentsService, PayoutsService, FraudService],
    };
  }
}
