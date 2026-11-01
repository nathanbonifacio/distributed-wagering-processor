import { Controller, Get, Header, Inject } from '@nestjs/common';
import { AppMetrics } from './app-metrics';

/** Texto no formato de exposição do Prometheus, sem exigir nenhum servidor: dá para ler com curl. */
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(AppMetrics) private readonly metrics: AppMetrics) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  render(): Promise<string> {
    return this.metrics.render();
  }
}
