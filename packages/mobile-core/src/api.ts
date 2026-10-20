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
  tripsCount: number;
  activeSince: number | null;
  tags: { tag: string; label: string; count: number }[];
  badges: { ally: boolean; womenRides: boolean };
}

export interface TripPrefs {
  quiet?: boolean;
  ac?: boolean;
  luggage?: boolean;
  pet?: boolean;
  wheelchair?: boolean;
}

export interface QuoteView {
  quoteId: string;
  fareCents: number;
  distanceM: number;
  durationS: number;
  expiresIn: number;
  breakdown: { baseCents: number; surgeCents: number; multiplier: number; reason: 'normal' | 'high_demand' | 'no_drivers_nearby'; driverEarnsCents: number; priceLocked: boolean };
}

export interface ChatMessage {
  type: 'chat';
  from: 'passenger' | 'driver';
  text?: string;
  kind?: 'voice' | 'photo' | 'video';
  mediaId?: string;
  durationMs?: number | null;
  at: string;
}

export interface UploadInstructions {
  method: 'POST' | 'PUT';
  url: string;
  fields?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface AssistView {
  id: string;
  kind: 'tow' | 'rental';
  status: 'open' | 'accepted' | 'arrived' | 'in_progress' | 'completed' | 'cancelled' | 'expired';
  offerCents: number;
  suggested: { minCents: number; maxCents: number };
  pickup: LatLng & { label: string | null };
  destination: (LatLng & { label: string | null }) | null;
  vehicleCategory: string;
  problem: string | null;
  startDate: string | null;
  days: number | null;
  provider: DriverCard | null;
  providerLocation: LatLng | null;
  expiresAt: string | null;
  rating: number | null;
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
  prefs: TripPrefs;
  reassignments: { used: number; max: number };
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
      c.call<QuoteView>('api', 'POST', '/v1/trips/quotes', { origin, destination, originLabel, destinationLabel }),
    requestTrip: (input: { quoteId: string; paymentMethod: PaymentMethod; paymentMethodId?: string; companions?: Person[]; forThirdParty?: Person; prefs?: TripPrefs; womenOnly?: boolean; allyOnly?: boolean }) =>
      c.call<TripView>('api', 'POST', '/v1/trips', input, { idempotencyKey: idempotencyKey() }),
    trip: (id: string) => c.call<TripView>('api', 'GET', `/v1/trips/${id}`),
    history: () => c.call<{ id: string; status: string; fareCents: number; finalFareCents: number | null; requestedAt: string }[]>('api', 'GET', '/v1/trips'),
    pin: (id: string) => c.call<{ pin: string }>('api', 'GET', `/v1/trips/${id}/pin`),
    cancel: (id: string, reason?: string) => c.call('api', 'POST', `/v1/trips/${id}/cancel`, { reason }),
    rate: (id: string, stars: number, tags: string[] = [], comment?: string) => c.call('api', 'POST', `/v1/trips/${id}/rating`, { stars, tags, comment }),
    reassign: (id: string, reason?: string) => c.call<{ status: string; remainingReassignments: number }>('api', 'POST', `/v1/trips/${id}/reassign`, { reason }),
    report: (id: string, category: string, description: string, evidenceMediaIds: string[] = []) => c.call<{ id: string; message: string }>('api', 'POST', `/v1/trips/${id}/reports`, { category, description, evidenceMediaIds }),
    myReports: () => c.call<{ id: string; category: string; status: string; createdAt: string }[]>('api', 'GET', '/v1/reports'),
    myFeedback: () => c.call<{ tag: string; label: string; count: number; positive: boolean }[]>('api', 'GET', '/v1/trips/me/feedback'),

    // Chat (texto por tiempo real; archivos por la API)
    chatHistory: (id: string) => c.call<ChatMessage[]>('api', 'GET', `/v1/trips/${id}/chat`),
    chatUploadUrl: (id: string, kind: 'voice' | 'photo' | 'video', contentType: string, size: number) =>
      c.call<{ mediaId: string; upload: UploadInstructions }>('api', 'POST', `/v1/trips/${id}/chat/media`, { kind, contentType, size }),
    chatComplete: (id: string, mediaId: string) => c.call<ChatMessage>('api', 'POST', `/v1/trips/${id}/chat/media/${mediaId}/complete`),
    chatMediaUrl: (id: string, mediaId: string) => c.call<{ url: string; contentType: string; kind: string; durationMs: number | null }>('api', 'GET', `/v1/trips/${id}/chat/media/${mediaId}`),

    // Seguridad del viaje en curso
    pendingSafetyCheck: (id: string) => c.call<{ id: string; kind: 'deviation' | 'long_stop'; respondBy: string } | null>('api', 'GET', `/v1/trips/${id}/safety-checks/pending`),
    answerSafetyCheck: (id: string, checkId: string, ok: boolean) => c.call('api', 'POST', `/v1/trips/${id}/safety-checks/${checkId}`, { ok }),

    // Perfil, inclusión y puntos
    preferences: () => c.call<{ chosenName: string | null; selfIdentifiesWoman: boolean; deviationAlerts: 'night' | 'always' | 'off'; defaultPrefs: TripPrefs }>('api', 'GET', '/v1/me/preferences'),
    setPreferences: (p: { chosenName?: string | null; selfIdentifiesWoman?: boolean; deviationAlerts?: 'night' | 'always' | 'off'; defaultPrefs?: TripPrefs }) => c.call('api', 'PUT', '/v1/me/preferences', p),
    loyalty: () => c.call<{ points: number; valueCents: number; rules: { redeemUnit: number; redeemMin: number; monthlyMax: number }; history: { points: number; kind: string; at: string }[] }>('api', 'GET', '/v1/loyalty'),
    redeem: (points: number) => c.call<{ creditedCents: number; balance: number }>('api', 'POST', '/v1/loyalty/redeem', { points }),

    // Grúas y alquiler (el usuario oferta; el primer proveedor que acepta gana)
    assistSuggest: (input: { kind: 'tow'; pickup: LatLng; destination: LatLng; vehicleCategory: string } | { kind: 'rental'; vehicleCategory: string; days: number }) =>
      c.call<{ minCents: number; maxCents: number; distanceM?: number }>('api', 'POST', '/v1/assist/suggest', input),
    assistRequest: (input: Record<string, unknown>) => c.call<AssistView>('api', 'POST', '/v1/assist/requests', input),
    assist: (id: string) => c.call<AssistView>('api', 'GET', `/v1/assist/requests/${id}`),
    assistRaise: (id: string, offerCents: number) => c.call<AssistView>('api', 'POST', `/v1/assist/requests/${id}/raise`, { offerCents }),
    assistCancel: (id: string) => c.call('api', 'POST', `/v1/assist/requests/${id}/cancel`, {}),
    assistRate: (id: string, stars: number) => c.call('api', 'POST', `/v1/assist/requests/${id}/rating`, { stars }),
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
    routes: () =>
      c.call<{ id: string; code: string; name: string; open: boolean; serviceHours: ServiceHours | null; currentFare: { name: string; amountCents: number } | null; currentFares: { taxi: { name: string; amountCents: number } | null; van: { name: string; amountCents: number } | null } }[]>('api', 'GET', '/v1/routes'),
    route: (id: string) => c.call<RouteDetail>('api', 'GET', `/v1/routes/${id}`),
    routeVehicles: (id: string, direction: string, stopId?: string) =>
      c.call<{ instanceId: string; vehicleType: 'taxi' | 'van'; vehicleLabel: string; seatsAvailable: number; vehicle: { plate: string; color: string; make: string; model: string }; location: LatLng | null; etaSeconds: number | null; currentUnitFareCents: number | null; currentFareName: string | null }[]>(
        'api', 'GET', `/v1/routes/${id}/vehicles?direction=${direction}${stopId ? `&stopId=${stopId}` : ''}`,
      ),
    switchVehicle: (bookingId: string, instanceId: string) => c.call<BookingView & { remainingSwitches: number }>('api', 'POST', `/v1/routes/bookings/${bookingId}/switch`, { instanceId }),
    routeQuote: (id: string, input: { direction: string; boardingStopId: string; alightingStopId: string; seats: number; vehicleType?: 'taxi' | 'van' }) =>
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

/** Horario de servicio de una ruta (hora de Guayaquil). `lastBoarding` es el último minuto para subir. */
export interface ServiceHours {
  start: string;
  end: string;
  lastBoarding: string;
}

export interface RouteDetail {
  id: string;
  code: string;
  name: string;
  corridor: string | null;
  open: boolean;
  serviceHours: ServiceHours | null;
  currentFare: { name: string; amountCents: number } | null;
  fares: { vehicleType: 'taxi' | 'van'; name: string; from: string; to: string; amountCents: number }[];
  fareNote: string;
  directions: { direction: 'outbound' | 'inbound'; label: string; stops: RouteStop[]; path: LatLng[] }[];
}

export interface BookingView {
  status: 'reserved' | 'boarded' | 'completed' | 'cancelled' | 'expired';
  vehicleType: 'taxi' | 'van';
  vehicleLabel: string;
  driver: DriverCard;
  switches: { used: number; max: number };
  route: { id: string; direction: 'outbound' | 'inbound'; boardingStopId: string; instanceId: string };
  seats: number;
  boardingStop: string;
  alightingStop: string;
  vehicle: { plate: string; color: string; make: string; model: string };
  fare: { final: true; ruleName: string; unitCents: number; totalCents: number } | { final: false; estimatedUnitCents: number; estimatedTotalCents: number };
  expiresAt: string | null;
}

export const money = (cents: number | null | undefined) => (typeof cents === 'number' ? `$${(cents / 100).toFixed(2)}` : '—');
