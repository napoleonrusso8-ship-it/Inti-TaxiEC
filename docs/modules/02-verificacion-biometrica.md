# Módulo 2 — Verificación biométrica

> Estado: **completado** — 2026-10-19. Pruebas: 7 unitarias (política), 8 de App Attest y 12 de extremo a extremo (auth + api reales).

## 1. Qué incluye

| Componente | Ubicación |
|---|---|
| API principal (base del monolito modular) | `apps/api` (`main.js` = api, `main-sos.js` = servicio SOS separado) |
| Consentimientos versionados (solo inserción) | `apps/api/src/modules/kyc/kyc.controller.ts`, migración `0004_kyc.sql` |
| Proveedor KYC: **Veriff** + proveedor simulado | `apps/api/src/modules/kyc/providers.ts` |
| Decisiones, duplicados, re-verificación y retención | `apps/api/src/modules/kyc/kyc.service.ts` |
| Política de re-verificación aleatoria del conductor | `apps/api/src/modules/kyc/reverification-policy.ts` |
| **App Attest (iOS)** | `apps/auth/src/modules/attestation/app-attest.ts`, migración `0003_app_attest.sql` |
| Pruebas e2e (servicios compilados como procesos reales) | `e2e/` |
| Simulador: sección "Módulo 2" | `apps/simulator` |

## 2. Flujo

```mermaid
sequenceDiagram
  autonumber
  participant App
  participant API as apps/api
  participant P as Veriff
  App->>API: GET /v1/consents/texts/biometric_kyc
  App->>API: POST /v1/consents {purpose, textVersion, textSha256}
  App->>API: POST /v1/kyc/sessions {kind: full}  [DPoP + atestación]
  API->>P: crea sesión (vendorData = id seudónimo de la verificación)
  API-->>App: URL / token del SDK
  App->>P: documento + selfie con prueba de vida (directo al proveedor)
  P->>API: webhook firmado (HMAC)
  API->>P: GET decisión (no se confía en el cuerpo del webhook)
  API->>API: guarda resultado + referencia + fecha; cédula cifrada, índice ciego y enmascarada
```

**Conductores:** antes de conectarse llaman a `POST /v1/kyc/reverification/check`. Si la política lo exige (primera vez, dispositivo nuevo, señal de riesgo, más de 7 días, o al azar con 20 % de probabilidad y máximo una vez al día, fuera de una ventana de gracia de 4 h), deben hacer una selfie (`kind: driver_reverify`). Solo se acepta si corresponde a **la misma persona** de la verificación completa.

## 3. Por qué Veriff
Ver `docs/01-arquitectura.md` §6. En resumen: liveness certificada (ISO/IEC 30107-3), detección de inyección de cámara virtual y deepfakes en el SDK, captura directa al proveedor (las imágenes no pasan por nuestros servidores), borrado por API y retención configurable. **Pendiente comercial:** precio, residencia de datos y cláusulas de transferencia internacional.

## 4. Endpoints

| Método | Ruta | Protección |
|---|---|---|
| GET | `/v1/consents/texts/{purpose}` | Público |
| GET | `/v1/consents` | Token |
| POST | `/v1/consents` | Token + atestación |
| DELETE | `/v1/consents/{purpose}` | Token |
| POST | `/v1/kyc/sessions` | Token + atestación + consentimiento |
| GET | `/v1/kyc/status` | Token |
| POST | `/v1/kyc/reverification/check` | Token + atestación |
| POST | `/v1/webhooks/kyc/{provider}` | Firma HMAC del proveedor |
| POST | `/v1/dev/kyc/sessions/{ref}/decide` | **Solo desarrollo** (`DEV_TOOLS=true`, prohibido en producción) |

## 5. Riesgos de seguridad y cómo se mitigan

| # | Riesgo | Mitigación | Prueba |
|---|---|---|---|
| R1 | **Fuga de biometría** | No se almacenan imágenes, vídeo ni plantillas (no hay columnas para ello); la captura va directa al proveedor; se pide el borrado al proveedor a los 30 días (`provider_delete_after`, tarea periódica) | `…guarda solo resultado, referencia y fecha…` |
| R2 | **Webhook falsificado** para aprobarse | Firma HMAC en tiempo constante + se **consulta la decisión al proveedor** + idempotencia; una verificación decidida no se reabre | `rechaza webhooks sin firma válida y no reabre…` |
| R3 | **Una misma identidad en varias cuentas** | Índice ciego HMAC de la cédula + índice único parcial en Postgres (incluida la condición de carrera) → `duplicate_review` | `marca para revisión manual un documento…` |
| R4 | **Cuenta de conductor prestada o vendida** | Re-verificación aleatoria/por riesgo/por dispositivo nuevo; la selfie debe coincidir con la persona original | `exige selfie antes de conectarse y la satisface solo si es la misma persona` |
| R5 | **Ataques de presentación** (foto, máscara, deepfake, cámara virtual) | Liveness certificada y detección de inyección del proveedor + atestación de la app (Play Integrity / **App Attest**) | Pruebas de App Attest |
| R6 | **Consentimiento inválido** | Consentimiento separado por finalidad, ligado a versión + hash del texto, solo inserción; revocar invalida el resultado y adelanta el borrado en el proveedor | `rechaza consentir un texto desactualizado`, `revocar el consentimiento…` |
| R7 | **App iOS falsificada** | App Attest: cadena X.509 hasta la raíz de Apple, nonce del servidor, keyId, AAGUID por entorno, contador monótono (anti repetición) | 8 pruebas con PKI de prueba |
| R8 | **Datos personales del documento** | Número y nombres cifrados por campo (AAD por fila); se muestran enmascarados (`09******78`) | e2e |
| R9 | **Herramientas de desarrollo en producción** | `/v1/dev/*` solo se registra con `DEV_TOOLS=true`; la configuración de producción lo prohíbe junto con el proveedor simulado | Validación de configuración |

### Riesgos residuales
- La integración con Veriff se probó con dobles; los nombres de campos de su API deben validarse contra su documentación vigente en el sandbox.
- La raíz de Apple (*Apple App Attestation Root CA*) se debe descargar de apple.com y fijar en la imagen (`APP_ATTEST_ROOT_CA_FILE`).
- La revisión manual de `duplicate_review` se hará en el panel de administración (módulo 10).

## 6. Revisión humana requerida
- **Legal (LOPDP art. 26, dato sensible):** textos de consentimiento (hoy son **borradores**), evaluación de impacto (EIPD), contrato de encargado con Veriff y transferencia internacional.
- **Seguridad:** prueba de App Attest con un iPhone real antes del lanzamiento.
