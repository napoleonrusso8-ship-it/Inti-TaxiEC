import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC es necesario para emitir los metadatos de decoradores que usa la inyección de dependencias de NestJS.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
