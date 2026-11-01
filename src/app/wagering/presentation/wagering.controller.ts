import { Body, Controller, Get, Headers, HttpStatus, Inject, NotFoundException, Param, Post, Res, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { identifierSchema, uuidSchema } from '../../../shared/application/contract-schemas';
import { currentContext } from '../../../shared/application/request-context';
import { ProviderAuthGuard } from '../../../shared/presentation/provider-auth.guard';
import { parseRequest } from '../../../shared/presentation/request-validation';
import { type ProcessWagerResult, ProcessWagerTransaction } from '../application/process-wager-transaction.use-case';
import { wagerPayloadSchema } from '../application/wager-command.schema';
import { WagerTransactionQueries } from '../application/wager-transaction-queries';
import { type WagerTransaction, WagerTransactionStatus as Status } from '../domain/wager-transaction.entity';

const idempotencyHeaderSchema = z.object({ 'Idempotency-Key': identifierSchema });

/** O status depende do resultado, então é definido aqui. Replay de rejeição ou pendência mantém o código original. */
function httpStatusOf({ status, idempotentReplay }: ProcessWagerResult): number {
  switch (status) {
    case Status.Rejected:
      return HttpStatus.UNPROCESSABLE_ENTITY;
    case Status.PendingReference:
    case Status.Pending:
      return HttpStatus.ACCEPTED;
    case Status.Failed:
      return HttpStatus.INTERNAL_SERVER_ERROR;
    case Status.Processed:
      return idempotentReplay ? HttpStatus.OK : HttpStatus.CREATED;
  }
}

function submissionResponse(result: ProcessWagerResult) {
  return {
    transactionId: result.transactionId,
    status: result.status,
    ...(result.balance ? { balance: result.balance.toJSON() } : {}),
    ...(result.failureCode ? { failureCode: result.failureCode } : {}),
    idempotentReplay: result.idempotentReplay,
  };
}

function transactionResponse(transaction: WagerTransaction) {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    failureCode: transaction.failureCode ?? null,
    balance: transaction.observedBalance?.toJSON() ?? null,
    attempts: transaction.attempts,
    nextAttemptAt: transaction.nextAttemptAt?.toISOString() ?? null,
    createdAt: transaction.createdAt.toISOString(),
    processedAt: transaction.processedAt?.toISOString() ?? null,
  };
}

const found = (transaction: WagerTransaction | undefined) => {
  if (!transaction) throw new NotFoundException({ code: 'TRANSACTION_NOT_FOUND', message: 'transaction not found' });
  return transactionResponse(transaction);
};

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransaction) private readonly processWager: ProcessWagerTransaction,
    @Inject(WagerTransactionQueries) private readonly queries: WagerTransactionQueries,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') rawKey: unknown,
    @Body() rawBody: unknown,
    @Res({ passthrough: true }) response: { status(code: number): unknown },
  ) {
    const { 'Idempotency-Key': idempotencyKey } = parseRequest(idempotencyHeaderSchema, { 'Idempotency-Key': rawKey });
    const result = await this.processWager.execute({
      ...parseRequest(wagerPayloadSchema, rawBody),
      idempotencyKey,
      correlationId: currentContext().correlationId,
    });
    response.status(httpStatusOf(result));
    return submissionResponse(result);
  }

  @Get('wagering/transactions/:transactionId')
  async getById(@Param('transactionId') rawId: string) {
    return found(await this.queries.getById(parseRequest(uuidSchema, rawId)));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(@Param('providerId') rawProviderId: string, @Param('externalTransactionId') rawExternalId: string) {
    return found(
      await this.queries.getByExternalId(parseRequest(identifierSchema, rawProviderId), parseRequest(identifierSchema, rawExternalId)),
    );
  }
}
