# 0005 — API HTTP

Status: implementada · Data: 31/10/2026.
Consolidada nas seções 6, 17 e 18 do `ARCHITECTURE.md` e na documentação de endpoints do `README.md`.

## Rotas

| Rota | Sucesso |
|---|---|
| `POST /wallets` | 201 |
| `GET /wallets/:walletId` | 200 |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | 200 |
| `POST /wagering/transactions` | 201, 200, 202 |
| `GET /wagering/transactions/:transactionId` | 200 |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | 200 |
| `GET /health/live`, `GET /health/ready` | 200 (já existiam) |

`POST /wallets/:walletId/reconciliation` **não existia neste registro** (foi entregue depois, junto do caso de uso de
reconciliação; ver 0009): na época não havia caso de uso de reconciliação.

## Status HTTP

| Situação | Status | Corpo |
|---|---|---|
| Primeira execução, PROCESSED | 201 | `idempotentReplay: false` |
| Replay de PROCESSED | 200 | Resultado e saldo originais, `idempotentReplay: true` |
| PENDING_REFERENCE, inclusive no replay | 202 | Sem `balance` |
| REJECTED, inclusive no replay | 422 | `failureCode` e saldo observado |
| Wallet inexistente na submissão | 422 | `code: WALLET_NOT_FOUND`, nada gravado |
| Payload, cursor, limite ou id inválidos; `Idempotency-Key` ausente | 400 | `code: INVALID_PAYLOAD`, `issues` |
| Conflito de idempotência | 409 | `code: IDEMPOTENCY_KEY_REUSED` |
| Wallet duplicada | 409 | `code: WALLET_ALREADY_EXISTS` |
| Consulta sem resultado | 404 | `code: WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND` |
| Falha transitória | 503 | `code: TEMPORARILY_UNAVAILABLE`, header `Retry-After` |
| FAILED, erro permanente ou inesperado | 500 | `code: INTERNAL_ERROR`; no replay, o estado FAILED |

**Interpretação:** o plano fala em 200 para replay. Rejeição e pendência mantêm 422 e 202 também no replay: o
código continua dizendo o que aconteceu com a operação, e `idempotentReplay` diz que é uma repetição.

## Erros

Todo erro é `{ code, message }`, mais `issues` na validação, em um filtro global (`src/api-exception.filter.ts`).
Mensagens de infraestrutura, causas do driver e stack traces nunca saem na resposta. O log de falhas não tratadas
leva só o nome do erro, porque a mensagem pode conter SQL; o diagnóstico completo ficou para a observabilidade (ver 0010).

## Validação

- zod, com schemas em `application` para o consumer SQS (ver 0008) reutilizar o de submissão.
- `amount` é string com exatamente 2 casas, pela regra única de `Money.from`. Não há coerção de `number`.
- UUIDs são normalizados para minúsculas. Sem isso, o mesmo id em maiúsculas viraria `PLAYER_WALLET_MISMATCH`
  e outro hash.
- Textos têm de 1 a 255 caracteres, sem caracteres de controle (o PostgreSQL recusaria NUL).
- Campos desconhecidos são recusados: o hash os ignoraria, e dois payloads diferentes pareceriam idênticos.

## OpenWallet

Está em `wagering` (opção A de 0001): cruza os dois agregados, e `wagering` já depende de `wallet`. A duplicidade é
decidida pela constraint `wallets_player_currency_unique`, que vale sob concorrência, e não por uma consulta prévia.
Saldo zero não gera transação, lançamento nem evento.

## Ledger

Paginação por keyset sobre `seq`, com cursor `base64url` validado (padrão 50, máximo 200 itens). `nextCursor` é
`null` quando a página não vem cheia. Se a última página vier exatamente cheia, a seguinte vem vazia: evita uma
leitura extra e não afeta a estabilidade.

## Autenticação

Decisão: **não há Identity Provider nesta solução**, porque autenticação não vale pontos (README, seção 2). O ponto
de extensão é o `ProviderAuthGuard`, um no-op aplicado aos controllers de negócio e ausente no health.

Desenho com IdP: validar o token OIDC no guard e comparar o provider autenticado com o `providerId` da requisição.
Sem isso, **qualquer cliente pode agir em nome de qualquer provider**; é uma limitação aceita para o desafio. O
`providerId` continua sujeito às validações de domínio, e `internal` é recusado.

## Módulos

Os controllers ficam em `WageringHttpModule` e `WalletHttpModule`, importados só pela API. O worker importa o
`WageringModule`, sem rotas, e não expõe a API de negócio (o health e as métricas foram adicionados depois; ver 0010). `ApiModule.register(env)` permite aos testes subirem o mesmo módulo
do `main.api.ts` em um banco descartável.
