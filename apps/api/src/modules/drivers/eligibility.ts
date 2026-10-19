/** Reglas puras de habilitación del conductor (se reutilizan al conectarse en el módulo 4). */
export const DRIVER_DOCS = ['license', 'background_check'] as const;
export const VEHICLE_DOCS = ['registration', 'insurance'] as const;

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
  licenseExpiresOn: string;
  vehicles: { id: string; status: string }[];
  docs: DocState[];
}

const valid = (d: DocState | undefined, today: string) =>
  !!d && d.reviewStatus === 'approved' && d.scanStatus === 'clean' && d.uploadStatus === 'uploaded' && (!d.expiresOn || d.expiresOn >= today);

/** Lista de motivos por los que el conductor no puede operar (vacía = puede). */
export function eligibilityIssues(i: EligibilityInput, opts: { forApproval?: boolean } = {}): string[] {
  const issues: string[] = [];
  if (!i.kycApproved) issues.push('kyc_not_approved');
  if (!opts.forApproval && i.profileStatus !== 'approved') issues.push(`profile_${i.profileStatus}`);
  if (i.licenseExpiresOn < i.today) issues.push('license_expired');
  for (const t of DRIVER_DOCS) {
    if (!valid(i.docs.find((d) => d.type === t && !d.vehicleId), i.today)) issues.push(`doc_${t}_missing_or_invalid`);
  }
  const usable = i.vehicles.filter(
    (v) => (opts.forApproval ? v.status !== 'rejected' && v.status !== 'inactive' : v.status === 'approved') &&
      VEHICLE_DOCS.every((t) => valid(i.docs.find((d) => d.type === t && d.vehicleId === v.id), i.today)),
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
