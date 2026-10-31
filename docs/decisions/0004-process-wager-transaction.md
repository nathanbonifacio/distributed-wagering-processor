# 0004 — ProcessWagerTransaction

Status: implementada na Etapa 5 · Data: 31/10/2026.
Destina-se às seções de concorrência, idempotência e interpretações do futuro `ARCHITECTURE.md`.

## Fluxo

Uma transação SQL por operação, em `ProcessWagerTransaction.execute`:

1. Valida e calcula o hash, antes de abrir a transação. OPENING e o provider `internal` são recusados aqui.
2. `SELECT ... FOR UPDATE` na wallet. Sem o lock, o saldo não é lido.
3. Procura a operação: replay ou conflito.
4. Sem operação existente e sem wallet: `WalletNotFoundError`, sem persistir.
5. Resolve a referência e a reversão existente.
6. `WagerProcessor` decide sobre o saldo lido sob o lock.
7. `insertIfAbsent` da transação no estado final; depois wallet, ledger e eventos.

Rejeição e pendência são resultados, e a transação confirma. Conflito, wallet inexistente e falhas de
infraestrutura são exceções, e a transação é desfeita.

## Por que o lock vem antes da idempotência

Duplicatas simultâneas da mesma wallet passam uma de cada vez: a primeira grava, e as seguintes encontram a
linha e viram replay. Assim a corrida comum nunca chega à constraint.

A mesma chave em wallets diferentes não é serializada pelo lock. Nesse caso `insertIfAbsent` espera a outra
transação e devolve `false`. Como nada foi gravado antes do insert, basta reler: em READ COMMITTED a linha
confirmada aparece, e o resultado é replay ou conflito. O plano previa refazer a transação; reler é suficiente
porque `ON CONFLICT DO NOTHING` não aborta a transação. Sem linha visível, o erro é transitório.

Não há ciclo de espera: cada operação trava uma única wallet e insere uma única transação.

## Idempotência

- **Chave:** `UNIQUE (idempotency_key)`, global. O default do README já inclui o provider. Dois providers com a
  mesma chave literal geram conflito, porque o provider faz parte do hash: é seguro e fica documentado.
- **Id externo:** `UNIQUE (provider_id, external_transaction_id)`. O mesmo id com outra chave é conflito.
- **Hash:** SHA-256 do JSON com chaves ordenadas de `providerId`, `externalTransactionId`, `playerId`, `walletId`,
  `roundId`, `gameId`, `kind`, `money` e `referenceExternalTransactionId` (omitido se ausente). Campos de
  transporte não entram.
- **Replay:** devolve id, estado, `failureCode` e o saldo gravados, com `idempotentReplay: true`. Não grava nada.
  Uma pendente devolve o estado atual, sem saldo.
- **Precedência:** chave existente com payload divergente é conflito mesmo quando a wallet informada não existe.

## Classificação de falhas

| Situação | Resultado | Estado gravado |
|---|---|---|
| Saldo insuficiente, referência inválida, reversão duplicada, moeda ou player divergente | `REJECTED` com `failureCode` | Sim |
| Referência ausente ou ainda pendente | `PENDING_REFERENCE` | Sim, agendada |
| Payload inválido ou OPENING externo | `InvalidMoneyError`, `InvalidWagerTransactionError` | Não |
| Conflito de idempotência | `IdempotencyConflictError` | Não |
| Wallet inexistente | `WalletNotFoundError` | Não |
| Lock timeout, deadlock, conexão | `TransientInfrastructureError` | Não: o reenvio decide |
| Constraint ou erro permanente | `PermanentInfrastructureError` | `FAILED`, em transação separada |
| Defeito de programação | Propagado | Não |

`FAILED` é terminal e não move saldo. O registro trava a wallet e usa `insertIfAbsent`, então nunca sobrescreve
uma operação concorrente. Se também falhar, prevalece o erro original.

## Referências

Resolvidas por `(providerId, referenceExternalTransactionId)`. Uma referência que exista só em outro provider
conta como ausente. A pendente nasce com `attempts = 0` e `next_attempt_at` 5 segundos à frente, o primeiro
intervalo de `min(5s·2^n, 5min)`. O retrier é da Etapa 10; `findDuePendingIds` e `WagerProcessor.process` já
aceitam a retomada.

## Outbox

O README exige o evento na mesma transação, então os eventos são gravados aqui: `IntegrationEvent`,
`WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference` e
`WalletBalanceChanged`. O `eventId` é o id da linha.

Continua na Etapa 8: `OutboxMessage`, backoff e o publisher. Nada é publicado nesta etapa, e nenhum evento é
gravado em replay ou em conflito.

## Fora desta etapa

- **Formato dos campos:** os UUIDs e o `kind` são validados pelo adaptador (zod). `Money` e as regras de
  `WagerTransaction` já são validados aqui.
- **Inbox:** a Etapa 9 precisa registrar a mensagem dentro desta mesma transação, por um parâmetro opcional do
  caso de uso. A persistência já expõe `inbox` no contexto.
- **OpenWallet:** continua em aberto (ver 0001). Os testes abrem as wallets com `processOpening`.
