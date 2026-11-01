import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { loadConfig } from './shared/infrastructure/config';
import { JsonLogger } from './shared/observability/json-logger';

const config = loadConfig();
const app = await NestFactory.create(WorkerModule.register(), { bufferLogs: true });
app.useLogger(new JsonLogger());
app.enableShutdownHooks();
// Porta interna do worker (health e, depois, /metrics); não é publicada no host pelo Compose.
await app.listen(config.WORKER_PORT, '0.0.0.0');
new Logger('Bootstrap').log({ msg: 'worker listening', port: config.WORKER_PORT });
