import { describe, expect, it } from 'vitest';
import { ALLOWED_VEHICLE_TYPES, eligibilityIssues, normalizePlate, PARTNER_KINDS, requiredDocs, todayInGuayaquil, type DocState, type EligibilityInput } from './eligibility.js';

const doc = (type: string, vehicleId: string | null = null, extra: Partial<DocState> = {}): DocState => ({
  type, vehicleId, reviewStatus: 'approved', scanStatus: 'clean', uploadStatus: 'uploaded', expiresOn: '2027-01-01', ...extra,
});
const base: EligibilityInput = {
  today: '2026-10-19',
  kycApproved: true,
  profileStatus: 'approved',
  licenseExpiresOn: '2028-01-01',
  vehicles: [{ id: 'v1', status: 'approved' }],
  docs: [doc('license'), doc('background_check'), doc('registration', 'v1'), doc('insurance', 'v1')],
};

describe('eligibilityIssues', () => {
  it('habilita a un conductor completo', () => expect(eligibilityIssues(base)).toEqual([]));
  it('exige KYC aprobado', () => expect(eligibilityIssues({ ...base, kycApproved: false })).toContain('kyc_not_approved'));
  it('detecta licencia vencida', () => expect(eligibilityIssues({ ...base, licenseExpiresOn: '2026-10-18' })).toContain('license_expired'));
  it('detecta un seguro vencido', () => {
    const docs = base.docs.map((d) => (d.type === 'insurance' ? { ...d, expiresOn: '2026-10-01' } : d));
    expect(eligibilityIssues({ ...base, docs })).toContain('no_valid_vehicle');
  });
  it('no acepta documentos sin revisar o con malware', () => {
    expect(eligibilityIssues({ ...base, docs: base.docs.map((d) => (d.type === 'license' ? { ...d, reviewStatus: 'pending' as const } : d)) })).toContain('doc_license_missing_or_invalid');
    expect(eligibilityIssues({ ...base, docs: base.docs.map((d) => (d.type === 'license' ? { ...d, scanStatus: 'infected' } : d)) })).toContain('doc_license_missing_or_invalid');
  });
  it('los documentos de un vehículo no sirven para otro', () => {
    expect(eligibilityIssues({ ...base, vehicles: [{ id: 'v2', status: 'approved' }] })).toContain('no_valid_vehicle');
  });
  it('para aprobar no exige que el perfil ya esté aprobado', () => {
    expect(eligibilityIssues({ ...base, profileStatus: 'under_review', vehicles: [{ id: 'v1', status: 'pending' }] }, { forApproval: true })).toEqual([]);
  });
});

describe('eligibilityIssues por tipo de socio', () => {
  const rental: EligibilityInput = {
    ...base,
    partnerKind: 'rental_company',
    licenseExpiresOn: null,
    vehicles: [{ id: 'v1', status: 'approved', vehicleType: 'rental' }],
    docs: [doc('company_ruc'), doc('registration', 'v1'), doc('insurance', 'v1')],
  };
  it('la empresa de alquiler no necesita licencia ni antecedentes, pero sí el certificado del RUC', () => {
    expect(eligibilityIssues(rental)).toEqual([]);
    expect(eligibilityIssues({ ...rental, docs: rental.docs.filter((d) => d.type !== 'company_ruc') })).toEqual(['doc_company_ruc_missing_or_invalid']);
  });
  it('sin partnerKind se comporta como conductor de taxi (compatibilidad)', () => {
    expect(eligibilityIssues({ ...base, partnerKind: undefined })).toEqual([]);
    expect(eligibilityIssues({ ...base, partnerKind: 'taxi_driver', docs: [doc('company_ruc'), doc('registration', 'v1'), doc('insurance', 'v1')] })).toEqual(
      expect.arrayContaining(['doc_license_missing_or_invalid', 'doc_background_check_missing_or_invalid']),
    );
  });
  it('los demás tipos exigen licencia vigente', () => {
    expect(eligibilityIssues({ ...base, partnerKind: 'tow_operator', licenseExpiresOn: null, vehicles: [{ id: 'v1', status: 'approved', vehicleType: 'tow' }] })).toContain('license_missing');
  });
  it('solo cuentan los vehículos del tipo permitido', () => {
    expect(eligibilityIssues({ ...base, partnerKind: 'van_owner' })).toContain('no_valid_vehicle');
    expect(eligibilityIssues({ ...base, partnerKind: 'van_owner', vehicles: [{ id: 'v1', status: 'approved', vehicleType: 'van' }] })).toEqual([]);
    expect(eligibilityIssues({ ...rental, vehicles: [{ id: 'v1', status: 'approved', vehicleType: 'taxi' }] })).toContain('no_valid_vehicle');
  });
  it('tabla de vehículos y documentos por tipo', () => {
    expect(ALLOWED_VEHICLE_TYPES).toEqual({ taxi_driver: ['taxi'], route_taxi_owner: ['taxi'], van_owner: ['van'], rental_company: ['rental'], tow_operator: ['tow'] });
    for (const k of PARTNER_KINDS) {
      expect(requiredDocs(k)).toEqual({ personal: k === 'rental_company' ? ['company_ruc'] : ['license', 'background_check'], vehicle: ['registration', 'insurance'] });
    }
  });
});

describe('normalizePlate', () => {
  it.each([['gsa1234', 'GSA-1234'], ['GSA-123', 'GSA-123'], [' pbx 0001 ', 'PBX-0001']])('%s → %s', (i, o) => expect(normalizePlate(i)).toBe(o));
  it.each(['GS-1234', 'GSAA-1234', 'GSA-12', "GSA-1234'; --"])('rechaza %s', (i) => expect(normalizePlate(i)).toBeNull());
});

describe('todayInGuayaquil', () => {
  it('usa la hora de Ecuador (UTC-5)', () => expect(todayInGuayaquil(new Date('2026-10-20T03:00:00Z'))).toBe('2026-10-19'));
});
