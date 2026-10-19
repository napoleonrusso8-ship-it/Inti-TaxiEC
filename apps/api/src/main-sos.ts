import { Logger } from '@nestjs/common';
import { createApp } from './bootstrap.js';
import { loadConfig } from './config.js';

// Servicio SOS: mismo código, despliegue y credenciales separados, solo carga los módulos de emergencia.
const config = loadConfig();
const app = await createApp(config, 'sos');
await app.listen(config.PORT);
new Logger('sos').log(`escuchando en :${config.PORT}`);
