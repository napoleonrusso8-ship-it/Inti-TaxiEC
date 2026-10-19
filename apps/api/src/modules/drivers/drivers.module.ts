import { type DynamicModule, Module } from '@nestjs/common';
import type { AppConfig } from '../../config.js';
import { AdminRolesController, DevAdminController } from '../admin/roles.controller.js';
import { AdminDriversController, DevStorageController, DriverController } from './drivers.controller.js';
import { DriversService } from './drivers.service.js';

@Module({})
export class DriversModule {
  static forConfig(c: AppConfig): DynamicModule {
    return {
      module: DriversModule,
      global: true,
      controllers: [DriverController, AdminDriversController, AdminRolesController, ...(c.DEV_TOOLS ? [DevStorageController, DevAdminController] : [])],
      providers: [
        DriversService,
      ],
      exports: [DriversService],
    };
  }
}
