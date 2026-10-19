import { type DynamicModule, Module } from '@nestjs/common';
import type { AppConfig } from '../../config.js';
import { EstimatorMapsAdapter, GoogleRoutesAdapter } from '../../infra/maps.js';
import { MAPS } from '../../tokens.js';
import { MatchingService } from './matching.service.js';
import { PresenceService } from './presence.service.js';
import { DriverTripsController, TripsController } from './trips.controller.js';
import { TripEvents } from './trip-events.js';
import { TripsService } from './trips.service.js';
import { RealtimeBridge } from './realtime-bridge.service.js';
import { TripTrackingService } from './trip-tracking.service.js';

@Module({})
export class TripsModule {
  static forConfig(c: AppConfig): DynamicModule {
    return {
      module: TripsModule,
      global: true,
      controllers: [TripsController, DriverTripsController],
      providers: [
        { provide: MAPS, useFactory: () => (c.MAPS_PROVIDER === 'google' ? new GoogleRoutesAdapter(c.GOOGLE_MAPS_API_KEY!) : new EstimatorMapsAdapter()) },
        TripEvents,
        PresenceService,
        MatchingService,
        TripsService,
        RealtimeBridge,
        TripTrackingService,
      ],
      exports: [TripsService, TripEvents, PresenceService, MatchingService, MAPS, RealtimeBridge, TripTrackingService],
    };
  }
}
