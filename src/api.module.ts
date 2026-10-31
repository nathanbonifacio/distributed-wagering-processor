import { Module } from '@nestjs/common';
import { HealthModule } from './app/health/health.module';
import { PersistenceModule } from './persistence.module';
import { ConfigModule } from './shared/infrastructure/config.module';

@Module({ imports: [ConfigModule.register(), PersistenceModule, HealthModule] })
export class ApiModule {}
