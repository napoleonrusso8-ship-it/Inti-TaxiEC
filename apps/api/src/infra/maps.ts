import { haversineMeters, type LatLng } from '@intitaxi/domain';

export interface RouteResult {
  distanceM: number;
  durationS: number;
  /** Polilínea codificada (formato de Google) si el proveedor la entrega. */
  polyline?: string;
}

export interface MapsPort {
  route(origin: LatLng, destination: LatLng, waypoints?: LatLng[]): Promise<RouteResult>;
}

/** Google Routes API (computeRoutes) con máscara de campos mínima. La clave de servidor no se expone al cliente. */
export class GoogleRoutesAdapter implements MapsPort {
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async route(origin: LatLng, destination: LatLng, waypoints: LatLng[] = []): Promise<RouteResult> {
    const wp = (p: LatLng) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
    const res = await this.fetchFn('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': this.apiKey, 'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline' },
      body: JSON.stringify({ origin: wp(origin), destination: wp(destination), intermediates: waypoints.map(wp), travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE', languageCode: 'es-419', units: 'METRIC' }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Routes API respondió ${res.status}`);
    const body = (await res.json()) as { routes?: { duration?: string; distanceMeters?: number; polyline?: { encodedPolyline?: string } }[] };
    const r = body.routes?.[0];
    if (!r?.distanceMeters || !r.duration) throw new Error('Routes API sin ruta');
    return { distanceM: r.distanceMeters, durationS: Number.parseInt(r.duration, 10), polyline: r.polyline?.encodedPolyline };
  }
}

/** Solo desarrollo: distancia en línea recta × 1.35 y 22 km/h promedio urbano. */
export class EstimatorMapsAdapter implements MapsPort {
  async route(origin: LatLng, destination: LatLng, waypoints: LatLng[] = []): Promise<RouteResult> {
    const pts = [origin, ...waypoints, destination];
    let d = 0;
    for (let i = 1; i < pts.length; i++) d += haversineMeters(pts[i - 1]!, pts[i]!);
    const distanceM = Math.round(d * 1.35);
    return { distanceM, durationS: Math.round(distanceM / (22_000 / 3600)) };
  }
}
