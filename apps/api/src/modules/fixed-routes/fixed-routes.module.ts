import { Module } from '@nestjs/common';
import { AdminRoutesController, DriverRoutesController, RoutesController } from './fixed-routes.controller.js';
import { FixedRoutesService } from './fixed-routes.service.js';
import { RoutesAdminService } from './routes-admin.service.js';

@Module({
  controllers: [RoutesController, DriverRoutesController, AdminRoutesController],
  providers: [FixedRoutesService, RoutesAdminService],
  exports: [FixedRoutesService],
})
export class FixedRoutesModule {}
