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
