/** Taxonomia estável e legível por máquina. Os valores fazem parte do contrato com o provedor. */
export enum FailureCode {
  /** BET sem saldo. Provedor: reenviar depois, como nova transação. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** Reversão deixaria o saldo negativo. Provedor: tratamento operacional. */
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  /** Referência não apareceu até o limite de tentativas. Provedor: corrigir ou desistir. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Referência existe, mas terminou REJECTED ou FAILED. Provedor: desistir. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** Tipo da referência não permitido para esta operação. Provedor: corrigir o payload. */
  ReferenceKindInvalid = 'REFERENCE_KIND_INVALID',
  /** Provider, player, wallet, moeda ou rodada diferem da referência. Provedor: corrigir o payload. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** Valor da reversão difere do valor da referência. Provedor: corrigir o payload. */
  AmountMismatch = 'AMOUNT_MISMATCH',
  /** A operação original já tem uma reversão. Provedor: desistir. */
  AlreadyReversed = 'ALREADY_REVERSED',
  /** A wallet não pertence ao player informado. Provedor: corrigir o payload. */
  PlayerWalletMismatch = 'PLAYER_WALLET_MISMATCH',
  /** Moeda da operação difere da moeda da wallet. Provedor: corrigir o payload. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** O crédito ultrapassaria o limite de NUMERIC(20,2). Provedor: tratamento operacional. */
  BalanceLimitExceeded = 'BALANCE_LIMIT_EXCEEDED',
  /** Só em FAILED: erro permanente de infraestrutura. Provedor: suporte e novo externalTransactionId. */
  InternalError = 'INTERNAL_ERROR',
}

const FAILED_CODES: ReadonlySet<FailureCode> = new Set([FailureCode.InternalError]);

/** Código de regra de negócio, válido em REJECTED. */
export function isRejectionCode(code: FailureCode): boolean {
  return !FAILED_CODES.has(code);
}

/** Código de erro permanente de infraestrutura, válido em FAILED. */
export function isFailedCode(code: FailureCode): boolean {
  return FAILED_CODES.has(code);
}
