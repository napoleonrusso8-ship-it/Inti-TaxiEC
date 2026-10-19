import { Logger } from '@nestjs/common';
import { createApp } from './bootstrap.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await createApp(config, 'api');
await app.listen(config.PORT);
new Logger('api').log(`escuchando en :${config.PORT}`);
