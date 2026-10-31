import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { APP_CONFIG, type AppConfig } from '../shared/infrastructure/config.module';

@Module({
  providers: [
    {
      provide: MikroORM,
      inject: [APP_CONFIG],
      // Construtor síncrono: só conecta na primeira query. Assim o processo sobe mesmo com o
      // PostgreSQL fora do ar e o /health/ready passa a responder 503 em vez do processo cair.
      useFactory: (config: AppConfig) =>
        new MikroORM({
          clientUrl: config.DATABASE_URL,
          entities: [],
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
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}
