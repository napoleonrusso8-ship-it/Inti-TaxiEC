import { Module } from '@nestjs/common';
import { AdminRoutesController, DriverRoutesController, RoutesController } from './fixed-routes.controller.js';
import { FixedRoutesService } from './fixed-routes.service.js';
import { RouteEnablementService } from './route-enablement.service.js';
import { RoutesAdminService } from './routes-admin.service.js';

@Module({
  controllers: [RoutesController, DriverRoutesController, AdminRoutesController],
  providers: [FixedRoutesService, RoutesAdminService, RouteEnablementService],
  exports: [FixedRoutesService],
})
export class FixedRoutesModule {}
