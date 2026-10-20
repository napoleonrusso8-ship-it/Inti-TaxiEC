import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSession, applicationBody, approvedDriver, decideKyc, grantConsent, randomPlate, randomRuc, uploadDoc, verifiedUser } from '../src/flows.js';
import { Stack } from '../src/stack.js';

const s = new Stack();
type Admin = Awaited<ReturnType<typeof adminSession>>;
let reviewer: Admin;
let managerA: Admin;
let managerB: Admin;
let r1: string;

const EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';

beforeAll(async () => {
  await s.start(['auth', 'api']);
  [reviewer, managerA, managerB] = (await Promise.all(['driver_reviewer', 'route_manager', 'route_manager'].map((r) => adminSession(s, r)))) as [Admin, Admin, Admin];
  // Publica la Ruta 1 sembrada siguiendo el flujo real del panel (cuatro ojos).
  r1 = (await s.pool.query(`SELECT id FROM fixed_routes.routes WHERE code = 'R1'`)).rows[0].id;
  await managerA.web.call('api', 'POST', `/v1/admin/routes/${r1}/validate`);
  await managerA.web.call('api', 'POST', `/v1/admin/routes/${r1}/publish-request`);
  const ok = await managerB.web.call('api', 'POST', `/v1/admin/routes/${r1}/publish-decision`, { approve: true });
  if (ok.status !== 200) throw new Error(`publish ${ok.status} ${JSON.stringify(ok.body)}`);
}, 120_000);
afterAll(() => s.stop());

describe('Tipos de socio', () => {
  it('sin partnerKind sigue siendo conductor de taxi; el perfil muestra tipo, vehículos y documentos exigidos, sin la licencia completa', async () => {
    const u = await verifiedUser(s, 'driver');
    const r = await u.d.call('api', 'POST', '/v1/driver/application', { licenseNumber: `L${u.doc}`, licenseCategory: 'C', licenseExpiresOn: '2029-12-31' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      status: 'applicant',
      partnerKind: 'taxi_driver',
      company: null,
      allowedVehicleTypes: ['taxi'],
      requiredDocs: { personal: ['license', 'background_check'], vehicle: ['registration', 'insurance'] },
    });
    expect(r.body.issues).toEqual(expect.arrayContaining(['doc_license_missing_or_invalid', 'no_valid_vehicle']));
    expect(JSON.stringify(r.body)).not.toContain(u.doc);
  });

  it('empresa de alquiler: RUC válido obligatorio, sin licencia; el perfil solo muestra el RUC enmascarado', async () => {
    const u = await verifiedUser(s, 'driver');
    const apply = (body: unknown) => u.d.call('api', 'POST', '/v1/driver/application', body);
    expect((await apply({ partnerKind: 'rental_company' })).status).toBe(400);
    expect((await apply({ partnerKind: 'rental_company', company: { businessName: 'Alquileres S.A.', ruc: '0912345678002' } })).body.title).toBe('invalid_ruc');
    expect((await apply({ partnerKind: 'tow_operator' })).status).toBe(400);
    const ruc = randomRuc();
    const r = await apply({ partnerKind: 'rental_company', company: { businessName: 'Alquileres del Río S.A.', ruc } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      partnerKind: 'rental_company',
      company: { businessName: 'Alquileres del Río S.A.', rucMasked: `${ruc.slice(0, 2)}*********${ruc.slice(-2)}` },
      license: null,
      allowedVehicleTypes: ['rental'],
      requiredDocs: { personal: ['company_ruc'], vehicle: ['registration', 'insurance'] },
    });
    expect(JSON.stringify(r.body)).not.toContain(ruc);
    const row = await s.pool.query(`SELECT ruc_enc, ruc_masked FROM drivers.profiles WHERE user_id = $1`, [u.userId]);
    expect(row.rows[0].ruc_enc.toString('latin1')).not.toContain(ruc);
    // Vehículos y documentos según el tipo.
    const vehicle = (vehicleType: string, seats: number) => u.d.call('api', 'POST', '/v1/driver/vehicles', { plate: randomPlate(), make: 'Kia', model: 'Sportage', year: 2023, color: 'Gris', seats, vehicleType, ...(vehicleType === 'rental' ? { rentalCategory: 'suv' } : {}) });
    expect((await vehicle('taxi', 4)).body.title).toBe('vehicle_type_not_allowed');
    expect((await vehicle('rental', 5)).status).toBe(201);
    expect((await uploadDoc(u.d, 'license')).body.title).toBe('document_type_not_allowed');
    expect((await uploadDoc(u.d, 'company_ruc')).status).toBe(200);
    // El mismo RUC no puede registrarse en otra cuenta.
    const other = await verifiedUser(s, 'driver');
    expect((await other.d.call('api', 'POST', '/v1/driver/application', { partnerKind: 'rental_company', company: { businessName: 'Otra S.A.', ruc } })).body.title).toBe('ruc_in_use');
  });

  it('la cola y el detalle del panel muestran el tipo de socio y la razón social', async () => {
    const drv = await approvedDriver(s, reviewer.web, 5, 'rental', 'auto');
    const queue = await reviewer.web.call('api', 'GET', '/v1/admin/drivers?status=approved');
    expect(queue.body.find((x: { driverId: string }) => x.driverId === drv.userId)).toMatchObject({ partnerKind: 'rental_company', businessName: 'Alquileres del Pacífico S.A.' });
    const detail = await reviewer.web.call('api', 'GET', `/v1/admin/drivers/${drv.userId}`);
    expect(detail.body).toMatchObject({ partnerKind: 'rental_company', company: { businessName: 'Alquileres del Pacífico S.A.' }, issuesForApproval: [] });
    expect(detail.body.company.rucMasked).toMatch(/^\d{2}\*+\d{2}$/);
    const profile = await drv.d.call('api', 'GET', '/v1/driver/profile');
    expect(profile.body).toMatchObject({ status: 'approved', issues: [] });
  });
});

describe('Taxi Ruta: solicitudes de habilitación desde la app', () => {
  it('el dueño de furgoneta pide la ruta con su vehículo; route_manager aprueba y queda habilitado', async () => {
    const van = await approvedDriver(s, reviewer.web, 10, 'van');
    const catalog = await van.d.call('api', 'GET', '/v1/driver/routes/catalog');
    expect(catalog.status).toBe(200);
    expect(catalog.body.find((r: { id: string }) => r.id === r1)).toMatchObject({ code: 'R1', enabled: false, request: null, serviceHours: { start: '06:30', end: '23:00' } });
    const req = await van.d.call('api', 'POST', `/v1/driver/routes/${r1}/enablement-requests`, { vehicleId: van.vehicleId });
    expect(req.status).toBe(201);
    expect(req.body).toMatchObject({ routeId: r1, vehicleId: van.vehicleId, status: 'pending' });
    expect((await van.d.call('api', 'POST', `/v1/driver/routes/${r1}/enablement-requests`, { vehicleId: van.vehicleId })).body.title).toBe('request_pending');

    const list = await managerA.web.call('api', 'GET', '/v1/admin/routes/enablement-requests?status=pending');
    expect(list.body.find((x: { id: string }) => x.id === req.body.id)).toMatchObject({
      routeCode: 'R1', driverId: van.userId, driverFirstName: 'Juan', partnerKind: 'van_owner', plate: van.plate, vehicleType: 'van', seats: 10, status: 'pending',
    });
    const dec = await managerA.web.call('api', 'POST', `/v1/admin/routes/enablement-requests/${req.body.id}/decision`, { approve: true });
    expect(dec.body).toEqual({ id: req.body.id, status: 'approved', routeId: r1, driverId: van.userId });
    expect((await managerA.web.call('api', 'POST', `/v1/admin/routes/enablement-requests/${req.body.id}/decision`, { approve: true })).body.title).toBe('invalid_state');

    const after = await van.d.call('api', 'GET', '/v1/driver/routes/catalog');
    expect(after.body.find((r: { id: string }) => r.id === r1)).toMatchObject({ enabled: true, request: { id: req.body.id, status: 'approved' } });
    expect((await van.d.call('api', 'GET', '/v1/driver/routes')).body.map((r: { id: string }) => r.id)).toContain(r1);
    expect((await van.d.call('api', 'POST', `/v1/driver/routes/${r1}/enablement-requests`, { vehicleId: van.vehicleId })).body.title).toBe('already_enabled');
    const audit = await s.pool.query(`SELECT action FROM audit.audit_log WHERE resource_id = $1 AND action LIKE 'route.%' ORDER BY seq`, [r1]);
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['route.enablement_request', 'route.driver_enable', 'route.enablement_decision']));
  });

  it('el rechazo deja el motivo visible para el socio; tipos y vehículos no permitidos', async () => {
    const owner = await approvedDriver(s, reviewer.web, 4, 'taxi', 'auto', 'route_taxi_owner');
    const req = await owner.d.call('api', 'POST', `/v1/driver/routes/${r1}/enablement-requests`, { vehicleId: owner.vehicleId });
    expect(req.status).toBe(201);
    await managerA.web.call('api', 'POST', `/v1/admin/routes/enablement-requests/${req.body.id}/decision`, { approve: false, reason: 'Falta la revisión técnica del vehículo' });
    const cat = await owner.d.call('api', 'GET', '/v1/driver/routes/catalog');
    expect(cat.body.find((r: { id: string }) => r.id === r1)).toMatchObject({ enabled: false, request: { status: 'rejected', reason: 'Falta la revisión técnica del vehículo' } });
    // Después de un rechazo puede volver a pedirla.
    expect((await owner.d.call('api', 'POST', `/v1/driver/routes/${r1}/enablement-requests`, { vehicleId: owner.vehicleId })).status).toBe(201);

    const tow = await approvedDriver(s, reviewer.web, 2, 'tow');
    expect((await tow.d.call('api', 'POST', `/v1/driver/routes/${r1}/enablement-requests`, { vehicleId: tow.vehicleId })).body.title).toBe('partner_kind_not_allowed');
    // Vehículo de otro socio (IDOR) y ruta inexistente.
    expect((await tow.d.call('api', 'POST', `/v1/driver/routes/${r1}/enablement-requests`, { vehicleId: owner.vehicleId })).status).toBe(403);
    const other = await approvedDriver(s, reviewer.web, 4, 'taxi');
    expect((await other.d.call('api', 'POST', `/v1/driver/routes/${r1}/enablement-requests`, { vehicleId: owner.vehicleId })).status).toBe(404);
    expect((await other.d.call('api', 'POST', `/v1/driver/routes/00000000-0000-4000-8000-000000000000/enablement-requests`, { vehicleId: other.vehicleId })).status).toBe(404);
    // Solo route_manager ve y decide.
    expect((await reviewer.web.call('api', 'GET', '/v1/admin/routes/enablement-requests')).status).toBe(403);
  });
});

describe('App única: un inicio de sesión, dos clientes (token exchange)', () => {
  /** Pasajero con la app única e identidad verificada. */
  async function appUser(integrity: 'ok' | 'basic' = 'ok') {
    const u = await s.loggedIn('passenger', integrity, 'ec.intitaxi.app');
    await grantConsent(u.d);
    const sess = await u.d.call('api', 'POST', '/v1/kyc/sessions', { kind: 'full' });
    const doc = `09${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}`;
    await decideKyc(s, sess.body.sessionUrl, { status: 'approved', documentNumber: doc, givenNames: 'Ana Lucía', familyNames: 'Vera Mora' });
    return { ...u, doc };
  }

  it('pasa de pasajero a socio sin otro SMS y usa la API de socio con la misma clave DPoP', async () => {
    const u = await appUser();
    const smsTo = async () => (await s.inbox()).filter((m) => m.to === u.phone.e164).length;
    const smsBefore = await smsTo();
    const x = await u.d.tokenExchange('intitaxi-driver');
    expect(x.status).toBe(200);
    expect(await smsTo()).toBe(smsBefore);
    const driverAt = x.body.access_token as string;
    // Con el token de pasajero la API de socio se niega; con el de socio, responde.
    expect((await u.d.call('api', 'GET', '/v1/driver/profile')).status).toBe(403);
    expect((await u.d.call('api', 'GET', '/v1/driver/profile', undefined, { accessToken: driverAt })).body.title).toBe('not_a_driver');
    const apply = await u.d.call('api', 'POST', '/v1/driver/application', applicationBody('route_taxi_owner', u.doc), { accessToken: driverAt });
    expect(apply.status).toBe(201);
    const profile = await u.d.call('api', 'GET', '/v1/driver/profile', undefined, { accessToken: driverAt });
    expect(profile.body).toMatchObject({ status: 'applicant', partnerKind: 'route_taxi_owner' });
    // El token de pasajero sigue sirviendo para la parte de pasajero.
    expect((await u.d.call('api', 'GET', '/v1/me/preferences')).status).toBe(200);
  });

  it('rechaza: otra clave DPoP, sesión revocada y pasajero → pasajero', async () => {
    const u = await appUser();
    const thief = await s.device('passenger', 'ok', 'ec.intitaxi.app');
    expect((await thief.tokenExchange('intitaxi-driver', u.d.accessToken)).body.error).toBe('invalid_grant');
    expect((await u.d.tokenExchange('intitaxi-passenger')).body.error).toBe('invalid_target');
    const at = u.d.accessToken;
    expect((await u.d.call('auth', 'POST', '/v1/auth/logout')).status).toBe(204);
    expect((await u.d.tokenExchange('intitaxi-driver', at)).body.error).toBe('invalid_grant');
    const audit = await s.pool.query(`SELECT metadata FROM audit.audit_log WHERE action = 'session.client_switch' AND outcome = 'denied' AND actor_user_id = $1`, [u.userId]);
    expect(audit.rows.map((r) => r.metadata.reason).sort()).toEqual(['dpop_key_mismatch', 'session_revoked']);
  });

  it('un teléfono con integridad básica viaja como pasajero pero no puede trabajar como socio', async () => {
    const u = await s.loggedIn('passenger', 'basic', 'ec.intitaxi.app');
    expect((await u.d.call('api', 'GET', '/v1/me/preferences')).status).toBe(200);
    const x = await u.d.tokenExchange('intitaxi-driver');
    expect(x.status).toBe(200);
    const r = await u.d.call('api', 'GET', '/v1/driver/profile', undefined, { accessToken: x.body.access_token });
    expect(r.status).toBe(403);
    expect(r.body.title).toBe('device_not_trusted');
    expect(r.body.detail).toBe('Para trabajar con Inti Taxi necesitas un teléfono sin modificaciones (integridad completa de Google Play).');
  });

  it('los metadatos del servidor anuncian el token exchange', async () => {
    const m = await (await fetch(`${s.urls.auth}/.well-known/oauth-authorization-server`)).json();
    expect(m.grant_types_supported).toContain(EXCHANGE);
  });
});
