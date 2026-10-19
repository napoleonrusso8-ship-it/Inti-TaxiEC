import { idempotencyKey, type ApiClient } from './client';

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Person {
  givenNames: string;
  familyNames: string;
  idType: 'cedula' | 'passport' | 'none';
  idNumber?: string;
  email?: string;
  phone?: string;
  isMinor?: boolean;
}

export interface DriverCard {
  firstName: string;
  identityVerified: boolean;
  vehicle: { plate: string; make: string; model: string; color: string } | null;
  rating: number | null;
  ratingsCount: number;
}

export interface TripView {
  id: string;
  type: 'on_demand' | 'fixed_route';
  status: 'matching' | 'no_drivers' | 'accepted' | 'arrived' | 'in_progress' | 'completed' | 'cancelled';
  role: string;
  origin: LatLng & { label: string | null };
  destination: LatLng & { label: string | null };
  fare: { quotedCents: number; finalCents: number | null; currency: string };
  distanceM: number;
  partySize: number;
  paymentMethod: string;
  driver: DriverCard | null;
  driverLocation: (LatLng & { at: number }) | null;
}

export type PaymentMethod = 'cash' | 'card' | 'wallet';

/** Llamadas de la app de pasajero, con los tipos que devuelve el servidor. */
export function passengerApi(c: ApiClient) {
  return {
    me: () => c.call<{ id: string; phone: string; email: string | null; emailVerified: boolean; kycLevel: string; sensitiveOpsLockedUntil: string | null }>('auth', 'GET', '/v1/me'),
    setEmail: (email: string) => c.call('auth', 'POST', '/v1/me/email', { email }),

    // KYC (el proveedor muestra su propia pantalla de selfie y documento)
    kycStatus: () => c.call<{ verification: { status: string } | null; [k: string]: unknown }>('api', 'GET', '/v1/kyc/status'),
    consentText: (purpose: string) => c.call<{ version: number; sha256: string; title: string; body: string }>('api', 'GET', `/v1/consents/texts/${purpose}`, undefined, { auth: false }),
    async grantConsent(purpose: string) {
      const t = await this.consentText(purpose);
      return c.call('api', 'POST', '/v1/consents', { purpose, textVersion: t.version, textSha256: t.sha256 });
    },
    startKyc: () => c.call<{ sessionUrl: string }>('api', 'POST', '/v1/kyc/sessions', { kind: 'full' }),

    // Viajes
    quote: (origin: LatLng, destination: LatLng, originLabel?: string, destinationLabel?: string) =>
      c.call<{ quoteId: string; fareCents: number; distanceM: number; durationS: number; expiresIn: number }>('api', 'POST', '/v1/trips/quotes', { origin, destination, originLabel, destinationLabel }),
    requestTrip: (input: { quoteId: string; paymentMethod: PaymentMethod; paymentMethodId?: string; companions?: Person[]; forThirdParty?: Person }) =>
      c.call<TripView>('api', 'POST', '/v1/trips', input, { idempotencyKey: idempotencyKey() }),
    trip: (id: string) => c.call<TripView>('api', 'GET', `/v1/trips/${id}`),
    history: () => c.call<{ id: string; status: string; fareCents: number; finalFareCents: number | null; requestedAt: string }[]>('api', 'GET', '/v1/trips'),
    pin: (id: string) => c.call<{ pin: string }>('api', 'GET', `/v1/trips/${id}/pin`),
    cancel: (id: string, reason?: string) => c.call('api', 'POST', `/v1/trips/${id}/cancel`, { reason }),
    rate: (id: string, stars: number, comment?: string) => c.call('api', 'POST', `/v1/trips/${id}/rating`, { stars, comment }),
    receipt: (id: string) => c.call<Record<string, any>>('api', 'GET', `/v1/trips/${id}/receipt`),
    shareLink: (id: string) => c.call<{ url: string; expiresIn: number; note: string }>('api', 'POST', `/v1/trips/${id}/share-links`),
    contactDriver: (id: string) => c.call<Record<string, any>>('api', 'POST', `/v1/trips/${id}/contact-session`),
    dispute: (id: string, category: string, description: string) => c.call('api', 'POST', `/v1/trips/${id}/disputes`, { category, description }),

    // Seguridad
    sos: (tripId: string, location?: LatLng) => c.call<{ incidentId: string; status: string; call: string }>('sos', 'POST', '/v1/sos', { tripId, location }),
    sosLocation: (incidentId: string, location: LatLng) => c.call('sos', 'POST', `/v1/sos/${incidentId}/location`, { location }),
    sosCancel: (incidentId: string, pin: string) => c.call<{ status: string }>('sos', 'POST', `/v1/sos/${incidentId}/cancel`, { pin }),
    setSafetyPins: (pin: string, duressPin: string, currentPin?: string) => c.call('sos', 'PUT', '/v1/me/safety-pins', { pin, duressPin, currentPin }),
    trustedContacts: () => c.call<{ id: string; name: string; phone: string }[]>('auth', 'GET', '/v1/me/trusted-contacts'),
    addTrustedContact: (name: string, phone: string) => c.call('auth', 'POST', '/v1/me/trusted-contacts', { name, phone }),

    // Pagos
    wallet: () => c.call<{ balanceCents: number; movements: { kind: string; amountCents: number; at: string }[] }>('api', 'GET', '/v1/wallet'),
    paymentMethods: () => c.call<{ id: string; brand: string; last4: string; status: string }[]>('api', 'GET', '/v1/payment-methods'),

    // Taxi Ruta
    routes: () => c.call<{ id: string; code: string; name: string; currentFare: { name: string; amountCents: number } | null }[]>('api', 'GET', '/v1/routes'),
    route: (id: string) => c.call<RouteDetail>('api', 'GET', `/v1/routes/${id}`),
    routeVehicles: (id: string, direction: string, stopId?: string) =>
      c.call<{ instanceId: string; seatsAvailable: number; vehicle: { plate: string; color: string; make: string; model: string }; location: LatLng | null; etaSeconds: number | null }[]>(
        'api', 'GET', `/v1/routes/${id}/vehicles?direction=${direction}${stopId ? `&stopId=${stopId}` : ''}`,
      ),
    routeQuote: (id: string, input: { direction: string; boardingStopId: string; alightingStopId: string; seats: number }) =>
      c.call<{ unitFareCents: number; totalCents: number; fareName: string; note: string; localTime: string }>('api', 'POST', `/v1/routes/${id}/quotes`, input),
    book: (id: string, input: { instanceId: string; direction: string; boardingStopId: string; alightingStopId: string; seats: number; paymentMethod: PaymentMethod; companions?: Person[] }) =>
      c.call<{ bookingId: string; tripId: string } & BookingView>('api', 'POST', `/v1/routes/${id}/bookings`, input),
    booking: (bookingId: string) => c.call<BookingView>('api', 'GET', `/v1/routes/bookings/${bookingId}`),
    cancelBooking: (bookingId: string) => c.call('api', 'POST', `/v1/routes/bookings/${bookingId}/cancel`),
  };
}

export interface RouteStop {
  id: string;
  name: string;
  reference: string | null;
  lat: number;
  lng: number;
  seq: number;
}

export interface RouteDetail {
  id: string;
  code: string;
  name: string;
  corridor: string | null;
  currentFare: { name: string; amountCents: number } | null;
  fares: { name: string; from: string; to: string; amountCents: number }[];
  fareNote: string;
  directions: { direction: 'outbound' | 'inbound'; label: string; stops: RouteStop[]; path: LatLng[] }[];
}

export interface BookingView {
  status: 'reserved' | 'boarded' | 'completed' | 'cancelled' | 'expired';
  seats: number;
  boardingStop: string;
  alightingStop: string;
  vehicle: { plate: string; color: string; make: string; model: string };
  fare: { final: true; ruleName: string; unitCents: number; totalCents: number } | { final: false; estimatedUnitCents: number; estimatedTotalCents: number };
  expiresAt: string | null;
}

export const money = (cents: number | null | undefined) => (typeof cents === 'number' ? `$${(cents / 100).toFixed(2)}` : '—');
