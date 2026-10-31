import { Module } from '@nestjs/common';
import { HealthModule } from './app/health/health.module';
import { ConfigModule } from './shared/infrastructure/config.module';

@Module({ imports: [ConfigModule.register(), HealthModule] })
export class ApiModule {}
