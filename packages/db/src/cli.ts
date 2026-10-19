import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPool, migrate } from './index.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL no definida');
  process.exit(1);
}
const caPath = process.env.DATABASE_SSL_CA;
if (process.env.NODE_ENV === 'production' && !caPath) {
  console.error('En producción la conexión a la base de datos debe usar TLS (DATABASE_SSL_CA)');
  process.exit(1);
}
const ssl = caPath ? ({ ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true } as const) : false;
const pool = createPool({ connectionString: url, applicationName: 'migrator', ssl });
const dir = resolve(process.env.MIGRATIONS_DIR ?? new URL('../../../db/migrations', import.meta.url).pathname);
migrate(pool, dir, console.log)
  .then((a) => console.log(`${a.length} migraciones aplicadas`))
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
