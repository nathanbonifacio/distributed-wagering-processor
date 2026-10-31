import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  /** Liveness: o processo responde. Não toca em nenhuma dependência externa. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: 200 se PostgreSQL e SQS respondem; 503 (com o relatório) se alguma falha. */
  @Get('ready')
  async ready() {
    const report = await this.health.checkReadiness();
    if (report.status !== 'ok') throw new ServiceUnavailableException(report);
    return report;
  }
}
