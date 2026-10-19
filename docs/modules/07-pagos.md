# Módulo 7 — Pagos

> Estado: **completado** — 2026-10-19. Pruebas: 2 unitarias (reparto sin pérdida de centavos) y 13 de extremo a extremo.

## 1. Qué incluye

| Componente | Ubicación |
|---|---|
| Pasarela: **Kushki** (esqueleto) y simulada | `apps/api/src/modules/payments/gateway.ts` |
| Cobro del viaje, recibos, billetera, reembolsos, webhooks | `payments.service.ts` |
| Retiros del conductor | `payouts.service.ts` |
| Antifraude por reglas | `fraud.service.ts` |
| Libro mayor de doble entrada | `ledger.ts`, migración `0010_payments.sql` |
| Claim `sol` (bloqueo anti SIM swap) en el token | `apps/auth/.../token.service.ts` |

## 2. Flujo y contabilidad

- **Tarjetas:** el SDK de la pasarela tokeniza la tarjeta; Inti Taxi recibe un **token de un solo uso**, lo cambia por una tarjeta guardada en la pasarela y guarda solo esa referencia (cifrada), la marca y los últimos 4 dígitos. **Alcance PCI DSS: SAQ A.** 3-D Secure se hace al registrar la tarjeta; los cobros posteriores son iniciados por el comercio.
- **Cobro:** al completarse el viaje, se cobra una sola vez (clave idempotente por viaje) el precio cerrado.
- **Asientos** (siempre cuadran; un trigger diferido lo exige al confirmar):

| Evento | Débito | Crédito |
|---|---|---|
| Viaje con tarjeta | `gateway_clearing` | `platform_revenue` (20 %) + `driver_payable:{conductor}` (80 %) |
| Viaje con billetera | `wallet:{pasajero}` | `platform_revenue` + `driver_payable` |
| Viaje en efectivo | `driver_payable` (comisión) | `platform_revenue` |
| Crédito promocional | `promo_expense` | `wallet:{pasajero}` |
| Reembolso | `refunds_issued` | `gateway_clearing` o `wallet` |
| Retiro solicitado → pagado | `driver_payable` → `payouts_pending` | `payouts_pending` → `bank_clearing` |

- **Cobro rechazado:** el conductor cobra igual; el pasajero queda con **deuda** que bloquea nuevos viajes hasta pagar con otra tarjeta.
- **Billetera: sin recargas** (decisión aprobada). Solo reembolsos y créditos de soporte (máx. 50 USD por operación, con motivo y auditoría).
- **Teléfono rooteado:** no puede registrar tarjetas ni pagar con tarjeta o billetera.

## 3. Retiros del conductor
1. Para registrar la cuenta bancaria se necesita **passkey reciente** (acr `phr`), sin bloqueo anti SIM swap, y que **el titular sea el propio conductor**: su cédula debe coincidir con la verificada por KYC (índice ciego).
2. Una cuenta nueva o cambiada **espera 72 h** antes de poder retirar; se avisa por SMS.
3. Para retirar se necesita passkey reciente y una `Idempotency-Key`; hay un mínimo, un máximo de 2 retiros al día y un candado por conductor (sin doble gasto).
4. Con señales de fraude abiertas (puntaje ≥ 60) el retiro pasa a `under_review`. Finanzas o antifraude lo marca como pagado (con la referencia SPI) o lo rechaza (el saldo se devuelve).

## 4. Antifraude (reglas iniciales)

| Señal | Regla | Puntaje |
|---|---|---|
| `card_shared` | Misma tarjeta física en ≥ 3 cuentas | 60 |
| `card_velocity` | > 3 tarjetas por día | 50 |
| `device_farm` | > 3 cuentas en un dispositivo | 50 |
| `ghost_trip` | > 1 km cotizado pero < 60 s o sin ruta GPS | 70 |
| `pair_frequency` | ≥ 5 viajes con el mismo pasajero en 7 días (80 si comparten dispositivo) | 40/80 |
| `mock_gps` | ≥ 3 ubicaciones falsas o imposibles en 24 h | 60 |

## 5. Riesgos de seguridad y cómo se mitigan

| # | Riesgo | Mitigación | Prueba |
|---|---|---|---|
| R1 | **Exposición de datos de tarjeta** | Tokenización en la pasarela, SAQ A; sin columnas de PAN/CVV; referencia cifrada | `cobro con tarjeta tokenizada…` |
| R2 | **Fraude con tarjeta robada** | 3-D Secure al registrar; límite de tarjetas por día; tarjeta compartida → señal | `3-D Secure…`, `antifraude…` |
| R3 | **Doble cobro** | Una clave idempotente por viaje; webhooks idempotentes | e2e |
| R4 | **Manipulación contable** | Libro mayor solo de inserción; trigger que rechaza asientos descuadrados | `es inmutable y cada asiento cuadra` |
| R5 | **Reembolsos excesivos / simultáneos** | Reserva atómica del monto antes de llamar a la pasarela; solo soporte con passkey ≤ 15 min | `reembolsos…` |
| R6 | **Robo de cuenta → desvío de ganancias** | Passkey (resistente al phishing), titular = conductor verificado, espera de 72 h, aviso por SMS, bloqueo anti SIM swap | `exige passkey…`, `bloqueo anti SIM swap…` |
| R7 | **Doble gasto en retiros** | Candado por conductor + verificación de saldo dentro de la transacción | `retira solo el saldo disponible, sin doble gasto…` |
| R8 | **Webhooks falsos** | Firma HMAC en tiempo constante | `rechaza webhooks falsificados` |
| R9 | **Colusión y viajes fantasma** | Reglas antifraude que retienen los retiros hasta revisión | Unitarias + e2e |

### Riesgos residuales y pendientes
- **Integración con Kushki:** el adaptador es un esqueleto; rutas, campos y firma de webhooks deben validarse en su entorno UAT con credenciales reales.
- **Facturación electrónica (SRI):** falta emitir comprobantes electrónicos de cada viaje (requisito tributario en Ecuador). Requiere un proveedor de facturación.
- **Transferencias a conductores:** hoy las marca finanzas tras la transferencia (archivo SPI/cash management); se puede automatizar con el banco.
- **Comisión del 20 %** y montos mínimos: valores de ejemplo.

## 6. Revisión requerida
- **QSA/PCI:** confirmar el alcance SAQ A con la integración real.
- **Legal/tributario:** facturación electrónica, retenciones a conductores y tratamiento de la deuda de pasajeros.
