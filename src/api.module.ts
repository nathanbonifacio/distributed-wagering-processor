import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ApiExceptionFilter } from './api-exception.filter';
import { HealthModule } from './app/health/health.module';
import { WageringHttpModule } from './app/wagering/presentation/wagering-http.module';
import { WalletHttpModule } from './app/wallet/presentation/wallet-http.module';
import { PersistenceModule } from './persistence.module';
import { ConfigModule } from './shared/infrastructure/config.module';

@Module({})
export class ApiModule {
  /** `env` explícito permite aos testes subir a API real em um banco descartável. */
  static register(env: Record<string, string | undefined> = process.env): DynamicModule {
    return {
      module: ApiModule,
      imports: [ConfigModule.register(env), PersistenceModule, WageringHttpModule, WalletHttpModule, HealthModule],
      providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
    };
  }
}
