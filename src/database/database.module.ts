import { type DynamicModule, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { type EntitySchema, MikroORM } from '@mikro-orm/postgresql';
import { APP_CONFIG, type AppConfig } from '../shared/infrastructure/config.module';

@Module({})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  /** Lista explícita de schemas: o database não conhece os módulos, e nada depende de busca em pastas. */
  static forRoot(entities: EntitySchema<any>[] = []): DynamicModule {
    return {
      module: DatabaseModule,
      global: true,
      providers: [
        {
          provide: MikroORM,
          inject: [APP_CONFIG],
          // Construtor síncrono: só conecta na primeira query. Assim o processo sobe mesmo com o
          // PostgreSQL fora do ar e o /health/ready passa a responder 503 em vez do processo cair.
          useFactory: (config: AppConfig) =>
            new MikroORM({
              clientUrl: config.DATABASE_URL,
              entities,
              discovery: { warnWhenNoEntities: false },
              allowGlobalContext: false,
              // `driverOptions` vira o objeto de opções do pg.Pool. Os timeouts abaixo limitam o
              // trabalho pendente no próprio driver, não só em quem espera (Promise.race).
              driverOptions: {
                connectionTimeoutMillis: config.DB_CONNECT_TIMEOUT_MS,
                query_timeout: config.DB_QUERY_TIMEOUT_MS,
                statement_timeout: config.DB_QUERY_TIMEOUT_MS,
              },
            }),
        },
      ],
      exports: [MikroORM],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}
