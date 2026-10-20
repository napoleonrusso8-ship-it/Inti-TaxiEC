/** Reglas puras de habilitación del socio (se reutilizan al conectarse en el módulo 4). */
export const DRIVER_DOCS = ['license', 'background_check'] as const;
export const VEHICLE_DOCS = ['registration', 'insurance'] as const;

/** Tipos de socio que se registran desde la app única. */
export const PARTNER_KINDS = ['taxi_driver', 'route_taxi_owner', 'van_owner', 'rental_company', 'tow_operator'] as const;
export type PartnerKind = (typeof PARTNER_KINDS)[number];
export type VehicleType = 'taxi' | 'van' | 'tow' | 'rental';

/** Tipos de vehículo que puede registrar cada tipo de socio. */
export const ALLOWED_VEHICLE_TYPES: Record<PartnerKind, readonly VehicleType[]> = {
  taxi_driver: ['taxi'],
  route_taxi_owner: ['taxi'],
  van_owner: ['van'],
  rental_company: ['rental'],
  tow_operator: ['tow'],
};

/** Documentos exigidos por tipo de socio: personales (o de la empresa) y de cada vehículo. */
export function requiredDocs(kind: PartnerKind): { personal: string[]; vehicle: string[] } {
  return { personal: kind === 'rental_company' ? ['company_ruc'] : [...DRIVER_DOCS], vehicle: [...VEHICLE_DOCS] };
}

/** Solo la empresa de alquiler opera sin licencia profesional (no conduce: alquila sus vehículos). */
export const requiresLicense = (kind: PartnerKind) => kind !== 'rental_company';

/** Categorías de licencia profesional admitidas para taxi. ⚠️ Confirmar con la normativa ANT vigente. */
export const PROFESSIONAL_LICENSE_CATEGORIES = ['C', 'C1', 'D', 'D1', 'E', 'E1'];

export interface DocState {
  type: string;
  vehicleId: string | null;
  reviewStatus: 'pending' | 'approved' | 'rejected';
  scanStatus: string;
  uploadStatus: string;
  expiresOn: string | null;
}

export interface EligibilityInput {
  today: string; // AAAA-MM-DD en America/Guayaquil
  kycApproved: boolean;
  profileStatus: string;
  /** Por omisión, conductor de taxi (compatibilidad con los perfiles anteriores a los tipos de socio). */
  partnerKind?: PartnerKind;
  licenseExpiresOn: string | null;
  vehicles: { id: string; status: string; vehicleType?: string }[];
  docs: DocState[];
}

const valid = (d: DocState | undefined, today: string) =>
  !!d && d.reviewStatus === 'approved' && d.scanStatus === 'clean' && d.uploadStatus === 'uploaded' && (!d.expiresOn || d.expiresOn >= today);

/** Lista de motivos por los que el conductor no puede operar (vacía = puede). */
export function eligibilityIssues(i: EligibilityInput, opts: { forApproval?: boolean } = {}): string[] {
  const issues: string[] = [];
  if (!i.kycApproved) issues.push('kyc_not_approved');
  if (!opts.forApproval && i.profileStatus !== 'approved') issues.push(`profile_${i.profileStatus}`);
  const kind = i.partnerKind ?? 'taxi_driver';
  const req = requiredDocs(kind);
  if (requiresLicense(kind) && (!i.licenseExpiresOn || i.licenseExpiresOn < i.today)) issues.push(i.licenseExpiresOn ? 'license_expired' : 'license_missing');
  for (const t of req.personal) {
    if (!valid(i.docs.find((d) => d.type === t && !d.vehicleId), i.today)) issues.push(`doc_${t}_missing_or_invalid`);
  }
  const allowed = ALLOWED_VEHICLE_TYPES[kind];
  const usable = i.vehicles.filter(
    (v) => allowed.includes((v.vehicleType ?? 'taxi') as VehicleType) &&
      (opts.forApproval ? v.status !== 'rejected' && v.status !== 'inactive' : v.status === 'approved') &&
      req.vehicle.every((t) => valid(i.docs.find((d) => d.type === t && d.vehicleId === v.id), i.today)),
  );
  if (usable.length === 0) issues.push('no_valid_vehicle');
  return issues;
}

/** Placa ecuatoriana: AAA-123 o AAA-1234 (se normaliza con guion y mayúsculas). */
export function normalizePlate(input: string): string | null {
  const m = /^([A-Za-z]{3})[\s-]?(\d{3,4})$/.exec(input.trim());
  return m ? `${m[1]!.toUpperCase()}-${m[2]}` : null;
}

export function todayInGuayaquil(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
