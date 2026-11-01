import { Global, Module } from '@nestjs/common';
import { AppMetrics } from './app-metrics';
import { MetricsController } from './metrics.controller';

/** Global: quem mede só injeta o AppMetrics, opcionalmente. A raiz da API e a do worker o importam uma vez. */
@Global()
@Module({ controllers: [MetricsController], providers: [AppMetrics], exports: [AppMetrics] })
export class ObservabilityModule {}
