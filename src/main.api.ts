import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ApiModule } from './api.module';
import { loadConfig } from './shared/infrastructure/config';

const config = loadConfig();
const app = await NestFactory.create(ApiModule);
app.enableShutdownHooks();
await app.listen(config.PORT, '0.0.0.0');
console.log(JSON.stringify({ msg: 'api listening', port: config.PORT }));
