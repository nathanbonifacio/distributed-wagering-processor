import { type DynamicModule, Global, Module } from '@nestjs/common';
import { type AppConfig, loadConfig } from './config';

/** Token de injeção: AppConfig é um tipo (zod infer), não uma classe, então precisa de um token. */
export const APP_CONFIG = Symbol('APP_CONFIG');
export type { AppConfig };

@Global()
@Module({})
export class ConfigModule {
  /**
   * `env` explícito permite aos testes configurar cada app sem tocar em `process.env`
   * (que é global ao processo e vazaria entre testes).
   */
  static register(env: Record<string, string | undefined> = process.env): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: loadConfig(env) }],
      exports: [APP_CONFIG],
    };
  }
}
