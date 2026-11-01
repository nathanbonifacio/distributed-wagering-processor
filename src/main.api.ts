import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ApiModule } from './api.module';
import { loadConfig } from './shared/infrastructure/config';
import { JsonLogger } from './shared/observability/json-logger';

const config = loadConfig();
const app = await NestFactory.create(ApiModule.register(), { bufferLogs: true });
app.useLogger(new JsonLogger());
app.enableShutdownHooks();
await app.listen(config.PORT, '0.0.0.0');
new Logger('Bootstrap').log({ msg: 'api listening', port: config.PORT });
