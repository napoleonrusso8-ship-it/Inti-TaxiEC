import { type DynamicModule, Module } from '@nestjs/common';
import { S3Client } from '@aws-sdk/client-s3';
import { randomBytes } from 'node:crypto';
import type { AppConfig } from '../../config.js';
import { LocalStorage, S3Storage } from '../../infra/storage.js';
import { STORAGE } from '../../tokens.js';
import { AdminGuard } from '../admin/admin.guard.js';
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
        AdminGuard,
        {
          provide: STORAGE,
          useFactory: () =>
            c.STORAGE_DRIVER === 's3'
              ? new S3Storage(new S3Client({ region: c.AWS_REGION }), c.S3_BUCKET!, c.S3_KMS_KEY_ID)
              : new LocalStorage(c.LOCAL_STORAGE_DIR, c.PUBLIC_BASE_URL, randomBytes(32)),
        },
      ],
      exports: [DriversService, STORAGE, AdminGuard],
    };
  }
}
