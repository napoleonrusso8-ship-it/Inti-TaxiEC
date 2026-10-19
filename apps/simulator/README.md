# Simulador de Inti Taxi

Herramienta **solo de desarrollo** para probar cada módulo contra los servicios reales, sin teléfonos.

```bash
pnpm install
pnpm dev          # requiere Docker (Postgres + Redis) o DATABASE_URL/REDIS_URL propios
# abre http://localhost:4000
```

- Cada "dispositivo" es una instalación simulada con su clave DPoP, atestación de desarrollo, passkey y Face ID por software.
- La **Bandeja** muestra los SMS y correos que habrían salido por Infobip / SES (proveedor `devbox`).
- La **Auditoría** muestra el log inmutable y si la cadena de hash está íntegra.
- El simulador se niega a arrancar con `NODE_ENV=production` y escucha solo en `127.0.0.1`.

## Probar Taxi Ruta (módulo 9)

La Ruta 1 está sembrada **en borrador**. Para publicarla hacen falta dos administradores distintos (cuatro ojos):

1. Crea dos dispositivos de administración con rol `route_manager` (A y B).
2. A: "Rutas" → copia el ID de `R1` → "Validar con mapas" (en desarrollo usa el estimador; avisa que las coordenadas no están verificadas) → "Solicitar publicación".
3. B: "Aprobar / rechazar publicación" → Aprobar.
4. Crea un conductor, apruébalo (sección de revisión) y conéctalo. A: "Habilitar conductor en la ruta".
5. Conductor: "Iniciar recorrido" (Ida). Pasajero: "Ver ruta y paradas" → "Reservar asiento(s)" (subida 1 = San Marino) → "Ver PIN".
6. Conductor: "Avanzar hasta la parada" 1 → "Confirmar subida (PIN)": la respuesta muestra la franja aplicada con la hora de Guayaquil ($3.00 antes de las 21:00, $4.00 desde las 21:00).
7. Conductor: "Avanzar hasta la parada" 6 → "Confirmar bajada". Pasajero: "Recibo".
