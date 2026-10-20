#!/usr/bin/env node
// Conecta un teléfono Android por USB a los servicios locales sin exponerlos a la red Wi-Fi:
// `adb reverse` hace que "localhost" en el teléfono sea esta computadora (auth, api, sos, tiempo real y Metro).
import { spawnSync } from 'node:child_process';

const PORTS = [3001, 3002, 3003, 3004, 8081];
const adb = (...args) => spawnSync('adb', args, { stdio: 'inherit' });

if (adb('version').error) {
  console.error('No se encontró "adb". Instala Android Studio (incluye Android SDK Platform-Tools) y agrégalo al PATH.');
  process.exit(1);
}
const devices = spawnSync('adb', ['devices'], { encoding: 'utf8' }).stdout.split('\n').filter((l) => /\tdevice$/.test(l));
if (!devices.length) {
  console.error('No hay teléfonos conectados. Activa "Depuración USB" en Opciones de desarrollador y acepta la huella de esta PC en el teléfono.');
  process.exit(1);
}
for (const p of PORTS) adb('reverse', `tcp:${p}`, `tcp:${p}`);
console.log(`\nListo: el teléfono usa localhost:${PORTS.join(', ')} de esta computadora.`);
console.log('Ahora: pnpm dev (servidores) y, en otra terminal, pnpm --filter @intitaxi/mobile start');
