import { Module } from '@nestjs/common';
import { AdminCommunityController, CommunityController, DriverCommunityController } from './community.controller.js';
import { CommunityService } from './community.service.js';
import { SafetyMonitorService } from './safety-monitor.service.js';

/** Comunidad: preferencias, inclusión (Modo Ellxs, Conductor Aliado), Inti Puntos y alerta de desvío. */
@Module({ controllers: [CommunityController, DriverCommunityController, AdminCommunityController], providers: [CommunityService, SafetyMonitorService] })
export class CommunityModule {}
