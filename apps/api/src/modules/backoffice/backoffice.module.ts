import { Module } from '@nestjs/common';
import { BackofficeController, DisputesController } from './backoffice.controller.js';
import { BackofficeService } from './backoffice.service.js';
import { DisputesService } from './disputes.service.js';

@Module({
  controllers: [DisputesController, BackofficeController],
  providers: [BackofficeService, DisputesService],
})
export class BackofficeModule {}
