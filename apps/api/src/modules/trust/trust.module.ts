import { Global, Module } from '@nestjs/common';
import { ReportsService } from './reports.service.js';
import { SanctionsService } from './sanctions.service.js';
import { AdminReportsController, ReportsController } from './trust.controller.js';

/** Confianza y seguridad: reportes entre usuarios y sanciones. */
@Global()
@Module({ controllers: [ReportsController, AdminReportsController], providers: [ReportsService, SanctionsService], exports: [SanctionsService] })
export class TrustModule {}
