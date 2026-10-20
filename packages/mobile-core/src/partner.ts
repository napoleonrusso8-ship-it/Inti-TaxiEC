import { idempotencyKey, type ApiClient } from './client';
import type { AssistView, ChatMessage, LatLng, ServiceHours, TripPrefs, TripView, UploadInstructions } from './api';

/** Cómo trabaja el socio con Inti Taxi (se elige en el menú de registro). */
export type PartnerKind = 'taxi_driver' | 'route_taxi_owner' | 'van_owner' | 'rental_company' | 'tow_operator';
export type VehicleKind = 'taxi' | 'van' | 'tow' | 'rental';
export type DocType = 'license' | 'background_check' | 'registration' | 'insurance' | 'company_ruc';

export interface PartnerVehicle {
  id: string;
  plate: string;
  make: string;
  model: string;
  year: number;
  color: string;
  seats_passenger: number;
  vehicle_type: VehicleKind;
  seats_verified: boolean;
  status: 'pending' | 'approved' | 'rejected' | 'inactive' | string;
}

export interface PartnerDocument {
  id: string;
  type: DocType;
  vehicleId: string | null;
  uploadStatus: string;
  scanStatus: string;
  reviewStatus: 'pending' | 'approved' | 'rejected';
  expiresOn: string | null;
  rejectionReason: string | null;
}

export interface PartnerProfile {
  status: 'applicant' | 'submitted' | 'under_review' | 'approved' | 'rejected' | 'suspended' | string;
  partnerKind: PartnerKind;
  company: { businessName: string; rucMasked: string } | null;
  license: { number: string | null; category: string | null; expiresOn: string | null };
  decisionReason: string | null;
  vehicles: PartnerVehicle[];
  documents: PartnerDocument[];
  allowedVehicleTypes: VehicleKind[];
  requiredDocs: { personal: DocType[]; vehicle: DocType[] };
  issues?: string[];
}

export interface Offer {
  offerId: string;
  tripId: string;
  expiresAt: string;
  pickupDistanceM: number;
  originLat: number;
  originLng: number;
  destLat: number;
  destLng: number;
  fareCents: number;
  surgeCents: number;
  prefs: TripPrefs;
  ellxsOnly: boolean;
  allyOnly: boolean;
  tripDistanceM: number;
  partySize: number;
  paymentMethod: string;
  passengerRating: number | null;
  passengerTrips: number;
}

export interface PassengerCard {
  firstName: string;
  usesChosenName: boolean;
  identityVerified: boolean;
  rating: number | null;
  ratingsCount: number;
  tripsCount: number;
  tags: { tag: string; label: string; count: number }[];
}

export type DriverTripView = TripView & { passenger?: PassengerCard };

export interface RouteCatalogItem {
  id: string;
  code: string;
  name: string;
  serviceHours: ServiceHours | null;
  enabled: boolean;
  request: { id: string; status: 'pending' | 'approved' | 'rejected'; reason: string | null } | null;
}

export interface RouteInstance {
  instanceId: string;
  vehicleType: 'taxi' | 'van';
  seatsTotal: number;
  seatsTaken: number;
  bookings: { id: string; status: 'reserved' | 'boarded'; seats: number; trip_id: string; boarding: string; boardingLat: number; boardingLng: number; alighting: string }[];
}

export interface AssistOpen {
  id: string;
  kind: 'tow' | 'rental';
  offerCents: number;
  suggested: { minCents: number; maxCents: number };
  /** Zona aproximada (≈100 m): la dirección exacta se ve al aceptar. */
  pickupArea: LatLng;
  distanceToPickupM: number | null;
  tripDistanceM: number | null;
  vehicleCategory: string;
  problem: string | null;
  startDate: string | null;
  days: number | null;
  expiresAt: string;
}

/** Llamadas del modo socio (conductor, dueño de taxi/furgoneta, empresa de alquiler, grúa). Usa el cliente intitaxi-driver. */
export function partnerApi(c: ApiClient) {
  return {
    // Registro
    profile: () => c.call<PartnerProfile>('api', 'GET', '/v1/driver/profile'),
    apply: (input: { partnerKind: PartnerKind; licenseNumber?: string; licenseCategory?: string; licenseExpiresOn?: string; company?: { businessName: string; ruc: string } }) =>
      c.call<PartnerProfile>('api', 'POST', '/v1/driver/application', input),
    addVehicle: (v: { plate: string; make: string; model: string; year: number; color: string; seats: number; vehicleType: VehicleKind; rentalCategory?: string }) =>
      c.call<{ id: string; plate: string }>('api', 'POST', '/v1/driver/vehicles', v),
    documentUploadUrl: (d: { type: DocType; vehicleId?: string; contentType: string; size: number; sha256: string; expiresOn?: string }) =>
      c.call<{ documentId: string; upload: UploadInstructions }>('api', 'POST', '/v1/driver/documents/upload-url', d),
    documentComplete: (id: string) => c.call<{ documentId: string; status: string; scanStatus: string }>('api', 'POST', `/v1/driver/documents/${id}/complete`),
    submit: () => c.call<{ status: string }>('api', 'POST', '/v1/driver/application/submit'),

    // Conexión y viajes a demanda
    online: (vehicleId: string, location: LatLng) => c.call('api', 'POST', '/v1/driver/online', { vehicleId, location }),
    offline: () => c.call('api', 'POST', '/v1/driver/offline'),
    location: (location: LatLng, mock = false) => c.call('api', 'POST', '/v1/driver/location', { location, mock }),
    offers: () => c.call<Offer[]>('api', 'GET', '/v1/driver/offers'),
    accept: (offerId: string) => c.call<{ tripId: string }>('api', 'POST', `/v1/driver/offers/${offerId}/accept`),
    reject: (offerId: string) => c.call('api', 'POST', `/v1/driver/offers/${offerId}/reject`),
    current: () => c.call<DriverTripView | { routeInstanceId: string } | null>('api', 'GET', '/v1/driver/trips/current'),
    trip: (id: string) => c.call<DriverTripView>('api', 'GET', `/v1/trips/${id}`),
    arrived: (id: string) => c.call('api', 'POST', `/v1/driver/trips/${id}/arrived`),
    start: (id: string, pin: string) => c.call('api', 'POST', `/v1/driver/trips/${id}/start`, { pin }),
    complete: (id: string) => c.call('api', 'POST', `/v1/driver/trips/${id}/complete`),
    ratePassenger: (id: string, stars: number, tags: string[] = []) => c.call('api', 'POST', `/v1/trips/${id}/rating`, { stars, tags }),
    report: (id: string, category: string, description: string, evidenceMediaIds: string[] = []) => c.call<{ id: string; message: string }>('api', 'POST', `/v1/trips/${id}/reports`, { category, description, evidenceMediaIds }),
    history: () => c.call<{ id: string; status: string; fareCents: number; finalFareCents: number | null; requestedAt: string }[]>('api', 'GET', '/v1/trips'),

    // Chat (mismos endpoints que el pasajero; el servidor sabe el rol)
    chatHistory: (id: string) => c.call<ChatMessage[]>('api', 'GET', `/v1/trips/${id}/chat`),
    chatUploadUrl: (id: string, kind: 'voice' | 'photo' | 'video', contentType: string, size: number) =>
      c.call<{ mediaId: string; upload: UploadInstructions }>('api', 'POST', `/v1/trips/${id}/chat/media`, { kind, contentType, size }),
    chatComplete: (id: string, mediaId: string) => c.call<ChatMessage>('api', 'POST', `/v1/trips/${id}/chat/media/${mediaId}/complete`),
    chatMediaUrl: (id: string, mediaId: string) => c.call<{ url: string; contentType: string; kind: string; durationMs: number | null }>('api', 'GET', `/v1/trips/${id}/chat/media/${mediaId}`),

    // Taxi Ruta y furgonetas
    routeCatalog: () => c.call<RouteCatalogItem[]>('api', 'GET', '/v1/driver/routes/catalog'),
    requestRoute: (routeId: string, vehicleId: string) => c.call<{ id: string; status: string }>('api', 'POST', `/v1/driver/routes/${routeId}/enablement-requests`, { vehicleId }),
    startRoute: (routeId: string, direction: 'outbound' | 'inbound', vehicleId: string) =>
      c.call<{ instanceId: string; seatsTotal: number; vehicleType: string }>('api', 'POST', `/v1/driver/routes/${routeId}/instances`, { direction, vehicleId }),
    routeInstance: () => c.call<RouteInstance | null>('api', 'GET', '/v1/driver/route-instances/current'),
    board: (instanceId: string, bookingId: string, pin: string) =>
      c.call<{ fare: { ruleName: string; unitCents: number; totalCents: number; localTime: string } }>('api', 'POST', `/v1/driver/route-instances/${instanceId}/board`, { bookingId, pin }),
    alight: (instanceId: string, bookingId: string) => c.call('api', 'POST', `/v1/driver/route-instances/${instanceId}/alight`, { bookingId }),
    finishRoute: (instanceId: string) => c.call<{ status: string }>('api', 'POST', `/v1/driver/route-instances/${instanceId}/finish`),

    // Grúa y alquiler (el primero que acepta gana)
    assistOpen: (kind: 'tow' | 'rental') => c.call<AssistOpen[]>('api', 'GET', `/v1/provider/assist/requests?kind=${kind}`),
    assistAccept: (id: string, vehicleId: string) => c.call<AssistView>('api', 'POST', `/v1/provider/assist/requests/${id}/accept`, { vehicleId }),
    assistStep: (id: string, step: 'arrived' | 'in_progress' | 'completed') => c.call<AssistView>('api', 'POST', `/v1/provider/assist/requests/${id}/${step}`),
    assist: (id: string) => c.call<AssistView & { role: string; notes: string | null; distanceM: number | null }>('api', 'GET', `/v1/assist/requests/${id}`),

    // Inclusión
    requestEllxs: () => c.call('api', 'POST', '/v1/driver/ellxs/request'),
    allyCourse: () => c.call<{ version: number; lessons: string[]; questions: { id: string; text: string; options: string[] }[] }>('api', 'GET', '/v1/driver/ally/course'),
    certifyAlly: (answers: Record<string, number>) => c.call<{ ally: boolean }>('api', 'POST', '/v1/driver/ally/certify', { answers }),
    vehicleFeatures: (vehicleId: string, features: ('ac' | 'pet_friendly' | 'wheelchair' | 'large_luggage')[]) => c.call('api', 'PUT', `/v1/driver/vehicles/${vehicleId}/features`, { features }),

    // Ganancias
    earnings: () =>
      c.call<{ availableCents: number; currency: string; trips: { tripId: string; endedAt: string; fareCents: number; paymentMethod: string }[]; payouts: { id: string; amountCents: number; status: string; requestedAt: string }[]; note?: string }>(
        'api', 'GET', '/v1/driver/earnings',
      ),
    payoutAccount: (input: { bankCode: string; accountType: 'savings' | 'checking'; accountNumber: string; holderName: string; holderCedula: string }) => c.call('api', 'POST', '/v1/driver/payout-accounts', input),
    payout: (amountCents: number) => c.call('api', 'POST', '/v1/driver/payouts', { amountCents }, { idempotencyKey: idempotencyKey() }),
  };
}

export type PartnerApi = ReturnType<typeof partnerApi>;

/** Qué se muestra en el menú de registro y qué pide cada perfil. */
export const PARTNER_KINDS: { kind: PartnerKind; icon: string; title: string; subtitle: string; vehicle: VehicleKind; needsLicense: boolean }[] = [
  { kind: 'taxi_driver', icon: '🚕', title: 'Nuevo conductor de taxi', subtitle: 'Recibe viajes a demanda en tu taxi', vehicle: 'taxi', needsLicense: true },
  { kind: 'route_taxi_owner', icon: '🛣️', title: 'Dueño de taxi amarillo · Taxi Ruta', subtitle: 'Opera rutas fijas cobrando por persona', vehicle: 'taxi', needsLicense: true },
  { kind: 'van_owner', icon: '🚐', title: 'Dueño de furgoneta · Taxi Ruta', subtitle: 'Rutas fijas con 5 a 15 asientos', vehicle: 'van', needsLicense: true },
  { kind: 'rental_company', icon: '🔑', title: 'Empresa de alquiler de autos', subtitle: 'Recibe ofertas de alquiler y acepta las que te convengan', vehicle: 'rental', needsLicense: false },
  { kind: 'tow_operator', icon: '🛻', title: 'Operador de grúa', subtitle: 'Atiende pedidos de grúa cerca de ti', vehicle: 'tow', needsLicense: true },
];

export const DOC_LABEL: Record<DocType, string> = {
  license: 'Licencia de conducir profesional',
  background_check: 'Certificado de antecedentes penales',
  registration: 'Matrícula del vehículo',
  insurance: 'Seguro (SPPAT u otro vigente)',
  company_ruc: 'Certificado del RUC de la empresa',
};

/** Motivos del servidor → texto para la persona. */
export function issueLabel(issue: string): string {
  if (issue === 'kyc_not_approved') return 'Verifica tu identidad con tu cédula y una selfie';
  if (issue === 'license_expired') return 'Tu licencia está vencida';
  if (issue === 'no_valid_vehicle') return 'Registra un vehículo con matrícula y seguro';
  if (issue.startsWith('profile_')) return 'Tu solicitud aún no está aprobada';
  const m = /^doc_(\w+?)_missing_or_invalid$/.exec(issue);
  if (m) return `Falta o no es válido: ${DOC_LABEL[m[1] as DocType] ?? m[1]}`;
  return issue;
}
