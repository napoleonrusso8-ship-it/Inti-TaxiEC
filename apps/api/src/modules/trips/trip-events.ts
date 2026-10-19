import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';

export interface TripStatusEvent {
  tripId: string;
  from: string | null;
  to: string;
  requesterUserId: string;
  driverId: string | null;
}

/**
 * Bus de eventos de dominio en proceso. Se emite DESPUÉS de confirmar la transacción.
 * Lo consumen tiempo real, pagos, manifiesto y notificaciones. (En multi-instancia: Redis pub/sub / SQS.)
 */
@Injectable()
export class TripEvents extends EventEmitter {
  emitStatus(e: TripStatusEvent) {
    this.emit('trip.status', e);
  }
  onStatus(fn: (e: TripStatusEvent) => void | Promise<void>) {
    this.on('trip.status', (e: TripStatusEvent) => {
      void Promise.resolve(fn(e)).catch(() => {});
    });
  }
}
