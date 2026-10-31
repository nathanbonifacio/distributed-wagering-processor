import { Module } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { APP_CONFIG, type AppConfig } from '../../../shared/infrastructure/config.module';

@Module({
  providers: [
    {
      provide: SQSClient,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new SQSClient({
          region: config.AWS_REGION,
          endpoint: config.SQS_ENDPOINT,
          // Credenciais explícitas só quando configuradas (LocalStack); senão, cadeia padrão da AWS.
          ...(config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY
            ? { credentials: { accessKeyId: config.AWS_ACCESS_KEY_ID, secretAccessKey: config.AWS_SECRET_ACCESS_KEY } }
            : {}),
          // Sem retries internos: quem decide retry é a camada de cima (health responde rápido).
          maxAttempts: 1,
        }),
    },
  ],
  exports: [SQSClient],
})
export class SqsModule {}
