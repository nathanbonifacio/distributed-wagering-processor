import { Module } from '@nestjs/common';
import { HealthModule } from './app/health/health.module';
import { WageringModule } from './app/wagering/wagering.module';
import { PersistenceModule } from './persistence.module';
import { ConfigModule } from './shared/infrastructure/config.module';

@Module({ imports: [ConfigModule.register(), PersistenceModule, WageringModule, HealthModule] })
export class ApiModule {}
