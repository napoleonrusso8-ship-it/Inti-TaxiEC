# Módulo 3 — Onboarding de conductores

> Estado: **completado** — 2026-10-19. Pruebas: 11 unitarias (habilitación, placas, zona horaria) y 12 de extremo a extremo.

## 1. Qué incluye

| Componente | Ubicación |
|---|---|
| Solicitud, vehículos y documentos | `apps/api/src/modules/drivers` |
| Reglas puras de habilitación (se usan también al conectarse) | `drivers/eligibility.ts` |
| Almacenamiento privado: S3 (POST prefirmado, SSE-KMS, GuardDuty) / local firmado | `apps/api/src/infra/storage.ts` |
| Inspección de archivos (magic bytes, PDF activo, EICAR) | `apps/api/src/infra/file-inspection.ts` |
| RBAC del panel (`AdminGuard`, roles con expiración) | `apps/api/src/modules/admin` |
| Inicio de sesión del panel **solo con passkey** | `apps/auth/src/modules/admin/admin-login.controller.ts` |
| Alta del primer super_admin (CLI auditada) | `apps/api/src/cli/grant-admin.ts` |
| Migraciones | `0005_web_clients.sql`, `0006_drivers_admin.sql` |

## 2. Flujo

1. El conductor (app de conductor, identidad verificada) envía la licencia: categoría profesional (C, C1, D, D1, E, E1), vigente, única entre cuentas (índice ciego) y cifrada.
2. Registra su vehículo: placa ecuatoriana `AAA-1234` única, antigüedad máxima configurable (15 años por defecto) y de 1 a 8 asientos.
3. Sube sus documentos: licencia y antecedentes, más la matrícula y el SOAT/SPPAT o seguro de cada vehículo.
   - Pide una URL firmada (tipo, tamaño y SHA-256 declarados) → sube **directo al almacenamiento** → `complete`.
   - El servidor comprueba el tamaño exacto, el hash, el tipo real (magic bytes), el contenido activo en PDF y el antimalware. Un archivo rechazado se borra.
4. Envía la solicitud: no se puede enviar incompleta.
5. Un revisor (`driver_reviewer`) ve los documentos con URLs de 60 s (con motivo y auditadas), los aprueba o rechaza uno a uno y aprueba al conductor solo si cumple todos los requisitos.

## 3. Endpoints

| Método | Ruta | Protección |
|---|---|---|
| POST | `/v1/driver/application` | Token (app conductor) + atestación |
| GET | `/v1/driver/profile` | Token (app conductor) + atestación |
| POST | `/v1/driver/vehicles` | Token (app conductor) + atestación |
| POST | `/v1/driver/documents/upload-url` | Token (app conductor) + atestación |
| POST | `/v1/driver/documents/{id}/complete` | Token (app conductor) + atestación; solo documentos propios |
| POST | `/v1/driver/application/submit` | Token (app conductor) + atestación |
| POST | `/v1/auth/admin/passkey/options` · `/verify` | DPoP (navegador); código válido solo para `intitaxi-admin` |
| GET | `/v1/admin/me` | Cualquier rol admin |
| GET | `/v1/admin/drivers?status=` · `/v1/admin/drivers/{id}` | `driver_reviewer` |
| POST | `/v1/admin/drivers/{id}/documents/{docId}/view-url` | `driver_reviewer` + motivo |
| POST | `/v1/admin/drivers/{id}/documents/{docId}/review` | `driver_reviewer` + passkey ≤ 15 min |
| POST | `/v1/admin/drivers/{id}/decision` | `driver_reviewer` + passkey ≤ 15 min |
| GET/POST/DELETE | `/v1/admin/users/{id}/roles` | `super_admin` (+ passkey ≤ 15 min para escribir) |

## 4. Riesgos de seguridad y cómo se mitigan

| # | Riesgo | Mitigación | Prueba |
|---|---|---|---|
| R1 | **Archivos maliciosos** (polyglots, PDF con JS, malware) | Tipos permitidos (JPEG/PNG/PDF), magic bytes, detección de `/JavaScript`, `/Launch`, `/OpenAction`…; antimalware (GuardDuty en S3, EICAR en local); el archivo rechazado se borra; las descargas usan `Content-Disposition: attachment` y nunca se sirven desde nuestro dominio | `rechaza tipo falsificado, PDF con JavaScript y malware…` |
| R2 | **Archivo sustituido** entre la declaración y la subida | SHA-256 y tamaño declarados y verificados; POST prefirmado con `content-length-range` y `Content-Type` fijos | `rechaza un archivo distinto del declarado…` |
| R3 | **Exposición de documentos** | Bucket privado + SSE-KMS; URLs de lectura de 60 s solo para revisores, con motivo obligatorio y auditoría (`purpose=driver_review`) | `las URLs de documentos exigen motivo…` |
| R4 | **IDOR** (usar el vehículo o documento de otro conductor) | Todas las consultas filtran por el conductor del token; 404 indistinguible | `no permite usar el vehículo ni completar documentos de otro conductor` |
| R5 | **Escalada de privilegios en el panel** | Token del cliente `intitaxi-admin` (solo passkey) + rol activo en BD en **cada** petición + passkey reciente para escribir; la app móvil no sirve aunque el usuario tenga el rol | `RBAC: sin rol, con otro rol o desde la app móvil…`, `el panel solo acepta passkey…` |
| R6 | **Abuso interno** | Separación de funciones: nadie se aprueba a sí mismo ni se asigna roles; solo super_admin asigna roles; todo queda en la auditoría inmutable | `un revisor no puede aprobarse a sí mismo…` |
| R7 | **Identidad duplicada / licencia prestada** | Licencia única por índice ciego; la solicitud exige KYC aprobado; la re-verificación del módulo 2 impide prestar la cuenta | e2e |
| R8 | **Conductor con documentos vencidos** | `eligibilityIssues` comprueba las fechas en la zona America/Guayaquil; se reutiliza al conectarse (módulo 4) | Unitarias |

### Riesgos residuales
- **Las imágenes no se re-codifican** (eliminaría metadatos EXIF y cargas ocultas). Recomendado con `sharp` en un worker aislado antes de producción.
- **Antecedentes penales:** se sube el certificado del Ministerio del Interior y lo revisa una persona; no hay verificación automática (requiere convenio).
- La **verificación de matrícula y licencia con la ANT** es manual hasta tener convenio.

## 5. Revisión humana requerida
- **Legal / regulatorio:** categorías de licencia admitidas para taxi, antigüedad máxima del vehículo (ATM Guayaquil) y base legal para tratar antecedentes penales.
- **Operación:** procedimiento de doble control para la CLI `grant-admin` (primer super_admin).
