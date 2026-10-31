import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { loadConfig } from './shared/infrastructure/config';

const config = loadConfig();
const app = await NestFactory.create(WorkerModule);
app.enableShutdownHooks();
// Porta interna do worker (health e, depois, /metrics); não é publicada no host pelo Compose.
await app.listen(config.WORKER_PORT, '0.0.0.0');
console.log(JSON.stringify({ msg: 'worker listening', port: config.WORKER_PORT }));
