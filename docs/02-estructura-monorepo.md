# 02 — Estructura del monorepo

> Estado: **APROBADO (2026-10-19)**.
> Herramientas: `pnpm` workspaces + Turborepo. TypeScript estricto en todo el repositorio.

```
inti-taxi/
├── apps/
│   ├── api/                      # Core API — monolito modular NestJS
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── common/           # guards (auth, policy, attestation), interceptors (audit), filters, pipes (validación)
│   │   │   ├── config/           # carga y validación de variables de entorno (Zod)
│   │   │   ├── modules/
│   │   │   │   ├── identity/         # usuarios, perfiles, dispositivos, contactos de confianza
│   │   │   │   ├── kyc/              # consentimientos, sesiones KYC, webhooks del proveedor
│   │   │   │   ├── drivers/          # onboarding, documentos, vehículos, re-verificación
│   │   │   │   ├── trips/            # cotización, solicitud, emparejamiento, estados, PIN
│   │   │   │   ├── companions/       # acompañantes, terceros, contactos frecuentes, avisos LOPDP
│   │   │   │   ├── manifest/         # manifiesto inmutable y enlaces firmados
│   │   │   │   ├── payments/         # pasarela, billetera (libro mayor), retiros, antifraude
│   │   │   │   ├── fixed-routes/     # Taxi Ruta: rutas, paradas, tarifas, reservas de asiento
│   │   │   │   ├── ratings/
│   │   │   │   ├── privacy/          # derechos ARCO+ (acceso, rectificación, eliminación, portabilidad)
│   │   │   │   ├── audit/
│   │   │   │   └── admin/            # endpoints de backoffice (RBAC + MFA)
│   │   │   └── infra/            # prisma/kysely, redis, kms, colas, clientes HTTP salientes
│   │   └── test/                 # integración (Testcontainers: Postgres+PostGIS, Redis)
│   ├── auth/                     # Servidor OIDC (node-oidc-provider): OTP, passkeys, MFA, DPoP
│   ├── realtime/                 # Gateway WebSocket (ubicación, seguimiento, chat)
│   ├── sos/                      # Servicio SOS aislado
│   ├── ecu911-adapter/           # Adaptador ECU 911 (implementaciones: mock | signed-link | convenio)
│   ├── workers/                  # Notificaciones, retención/borrado, antifraude, conciliación
│   ├── admin-web/                # Panel admin (Next.js) — sin SSR de datos sensibles en caché
│   ├── tracking-web/             # Página pública de seguimiento por enlace firmado (terceros sin app)
│   ├── mobile/                   # React Native — app única (pasajeros y socios)
│   └── mobile-driver/            # React Native — conductor
├── packages/
│   ├── domain/                   # tipos y reglas puras: cédula (mód. 10), tarifas por franja, máquina de estados del viaje
│   ├── validation/               # esquemas Zod compartidos (API ↔ clientes)
│   ├── api-client/               # cliente tipado generado desde OpenAPI
│   ├── crypto/                   # envelope encryption, HMAC de índices ciegos, enmascarado
│   ├── mobile-security/          # pinning, RASP, atestación, almacenamiento seguro, detección de mock GPS
│   ├── ui/                       # componentes compartidos (RN / web)
│   ├── eslint-config/            # incluye reglas de límites entre módulos y reglas de seguridad
│   └── tsconfig/
├── infra/
│   ├── terraform/
│   │   ├── modules/              # vpc, rds, elasticache, kms, waf, ecs/eks, s3-object-lock, siem
│   │   └── envs/{dev,staging,prod}/
│   ├── policies/                 # OPA/Conftest para IaC
│   └── docker/                   # Dockerfiles distroless, non-root
├── db/
│   ├── migrations/               # SQL versionado (incluye RLS, triggers append-only)
│   └── seeds/                    # SOLO datos ficticios (cédulas válidas sintéticas, Ruta 1)
├── docs/
│   ├── 00-especificacion.md
│   ├── 01-arquitectura.md
│   ├── 02-estructura-monorepo.md
│   ├── 03-modelo-datos.md
│   ├── 04-modelo-amenazas-stride.md
│   ├── 05-endpoints.md
│   ├── 06-decisiones-pendientes.md
│   ├── adr/                      # Architecture Decision Records
│   ├── modules/                  # un documento por módulo con "Riesgos de seguridad y cómo se mitigan"
│   └── runbooks/                 # respuesta a incidentes, notificación de brechas LOPDP, rotación de claves
├── .github/
│   ├── workflows/                # ci.yml (lint, test, SAST, SCA, secretos, Trivy), dast.yml, mobile.yml
│   ├── CODEOWNERS                # revisión obligatoria de seguridad en auth/, kyc/, payments/, sos/, infra/
│   └── dependabot.yml
├── .env.example                  # sin valores reales
├── .gitleaks.toml
├── .semgrep.yml
├── docker-compose.yml            # Postgres+PostGIS, Redis, LocalStack (KMS/S3/SQS), mocks de proveedores
├── turbo.json
├── pnpm-workspace.yaml
└── SECURITY.md                   # política de divulgación responsable (base del futuro bug bounty)
```

## Reglas del repositorio
- **Límites:** `modules/X` solo importa la API pública (`index.ts`) de `modules/Y`; cada módulo accede únicamente a su propio esquema Postgres. Se imponen con `eslint-plugin-boundaries` en CI.
- **Secretos:** ningún secreto en el código ni en `.env` versionado; `gitleaks` en pre-commit y en CI; la app móvil no contiene claves privadas (las claves de mapas de cliente se restringen por *bundle id*/huella del certificado).
- **Dependencias:** versiones exactas (`save-exact`), `pnpm` con `onlyBuiltDependencies` para bloquear scripts `postinstall` no autorizados, SBOM por build.
- **Ramas:** `main` protegida, PR con 2 aprobaciones (1 de seguridad en rutas de `CODEOWNERS`), commits firmados.
