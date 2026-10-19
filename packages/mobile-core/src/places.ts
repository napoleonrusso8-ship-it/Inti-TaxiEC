import type { LatLng } from './api';

/**
 * Lugares de referencia en Guayaquil (coordenadas aproximadas) para elegir origen/destino rápido
 * cuando no hay búsqueda de direcciones (sin clave de Google Places en desarrollo).
 */
export const PLACES: { name: string; at: LatLng }[] = [
  { name: 'Mall del Sol', at: { lat: -2.1547, lng: -79.8929 } },
  { name: 'Malecón 2000', at: { lat: -2.1939, lng: -79.8803 } },
  { name: 'Aeropuerto José Joaquín de Olmedo', at: { lat: -2.1574, lng: -79.8837 } },
  { name: 'Terminal Terrestre', at: { lat: -2.1407, lng: -79.8885 } },
  { name: 'Parque Centenario', at: { lat: -2.1896, lng: -79.8885 } },
  { name: 'City Mall', at: { lat: -2.1405, lng: -79.9068 } },
  { name: 'Riocentro Norte', at: { lat: -2.1357, lng: -79.9024 } },
  { name: 'San Marino', at: { lat: -2.17, lng: -79.8986 } },
  { name: 'Urdesa', at: { lat: -2.1745, lng: -79.9126 } },
  { name: 'Samborondón', at: { lat: -2.146, lng: -79.864 } },
];
