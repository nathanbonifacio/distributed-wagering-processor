# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`) recebidas de provedores de jogos por **HTTP** e por **AWS SQS**. O foco é a correção financeira sob duplicidade, desordem e concorrência: nenhum crédito ou débito é duplicado, o saldo nunca fica negativo e o saldo materializado da wallet é sempre explicável pelo ledger.

Principais garantias (detalhes em [ARCHITECTURE.md](ARCHITECTURE.md)):

- **Dinheiro exato**: `decimal.js` e `NUMERIC(20,2)`, sempre como string decimal com 2 casas. Nenhum `number` representa valor monetário.
- **Concorrência por wallet**: `SELECT … FOR UPDATE` na linha da wallet, com o saldo lido depois do lock. Wallets diferentes nunca se bloqueiam.
- **Idempotência persistente**: `UNIQUE` no banco (chave de idempotência e `(providerId, externalTransactionId)`) e um inbox persistente para as mensagens SQS. Nada vive em memória.
- **Ledger imutável**: lançamentos só são inseridos; `UPDATE`, `DELETE` e `TRUNCATE` são bloqueados por trigger.
- **Transactional Outbox**: eventos de integração são gravados na mesma transação SQL da alteração financeira e publicados depois do commit, por qualquer instância.
- **Correto com várias instâncias**: API e workers são processos independentes sem estado compartilhado fora do PostgreSQL e do SQS.

## Stack

| Item | Escolha |
|---|---|
| Runtime, gerenciador de pacotes e test runner | Bun 1.x (validado com 1.4.4) |
| Linguagem | TypeScript em modo estrito |
| Framework | NestJS |
| Banco | PostgreSQL 16 |
| ORM | MikroORM (com `EntitySchema`, sem decorators de persistência nas classes de domínio) |
| Mensageria | AWS SQS (LocalStack 4.4 no ambiente local), SDK v3 |
| Dinheiro | `decimal.js` |
| Validação de contratos | `zod` (o mesmo schema vale para HTTP e SQS) |
| Logs e métricas | `pino` (JSON) e `prom-client` |
| Orquestração local | Docker Compose |

## Pré-requisitos

- [Docker](https://docs.docker.com/get-docker/) com Docker Compose v2 (`docker compose`).
- [Bun](https://bun.sh) 1.x, apenas para rodar migrations, testes e o typecheck no host. Para só executar a aplicação, o Docker basta.
- `curl` para os exemplos.

> **Terminal.** Os exemplos de linha de comando deste documento foram escritos para **Bash** (Linux, macOS, WSL ou Git Bash no Windows): `cp`, atribuições como `API=http://…`, continuação de linha com `\`, aspas simples em JSON e `$VARIAVEL`. No **PowerShell** é preciso adaptá-los (por exemplo `Copy-Item .env.example .env`, `$API = "…"`, o acento grave `` ` `` como continuação de linha, e `curl.exe` no lugar do alias `curl`, além de cuidar das aspas do JSON). Os comandos `docker compose …` e `bun run …` funcionam igual em qualquer terminal.

## Configuração

Copie o arquivo de exemplo. Ele contém apenas valores fictícios de desenvolvimento e o `.env` real é ignorado pelo Git.

```bash
cp .env.example .env
```

O Compose interpola o `.env` (portas e credenciais do Postgres). O Bun também o carrega sozinho em `bun run` e `bun test`. Os containers **não** recebem `DATABASE_URL` nem `SQS_ENDPOINT` do `.env`: o Compose monta os endereços internos (`postgres` e `localstack`). Esses dois valores servem aos processos executados no host.

Sem `.env`, os padrões do Compose e dos testes são os mesmos do `.env.example`.

### Variáveis do `.env.example`

| Variável | Padrão | Uso |
|---|---|---|
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | `wagering` | credenciais e banco do container PostgreSQL |
| `POSTGRES_PORT` | `5432` | porta publicada no host |
| `AWS_REGION` | `us-east-1` | região do SQS |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `test` | credenciais fictícias exigidas pelo SDK com o LocalStack |
| `LOCALSTACK_PORT` | `4566` | porta publicada no host |
| `LOCALSTACK_AUTH_TOKEN` | vazio | opcional; a imagem 4.4 usada não exige token |
| `DATABASE_URL` | `postgres://wagering:wagering@localhost:5432/wagering` | processos no host |
| `SQS_ENDPOINT` | `http://localhost:4566` | processos no host |

### Variáveis de ajuste da aplicação (opcionais)

Validadas na subida (`src/shared/infrastructure/config.ts`); valores inválidos derrubam o processo com a lista de problemas. Os padrões abaixo são os do código.

| Variável | Padrão | Significado |
|---|---|---|
| `PORT` / `WORKER_PORT` | `3000` / `3100` | porta HTTP da API / do worker (health e métricas) |
| `SQS_INPUT_QUEUE_NAME` | `wager-transactions.fifo` | fila de entrada |
| `SQS_DLQ_QUEUE_NAME` | `wager-transactions-dlq.fifo` | fila de mensagens mortas |
| `SQS_EVENTS_QUEUE_NAME` | `wager-events` | destino dos eventos da outbox |
| `SQS_CONSUMER_BATCH_SIZE` | `10` | mensagens por recebimento (máx. 10) |
| `SQS_CONSUMER_WAIT_SECONDS` | `10` | long polling |
| `SQS_CONSUMER_RETRY_BASE_SECONDS` | `5` | primeiro atraso do retry transitório; dobra a cada recebimento, até 300 s |
| `SQS_CONSUMER_SHUTDOWN_TIMEOUT_MS` | `8000` | espera pelas mensagens em andamento no encerramento |
| `HEALTH_CHECK_TIMEOUT_MS` | `2000` | prazo de cada dependência no `/health/ready` |
| `DB_CONNECT_TIMEOUT_MS` | `5000` | prazo de conexão com o PostgreSQL |
| `DB_QUERY_TIMEOUT_MS` | `30000` | teto de duração de uma query |
| `DB_LOCK_TIMEOUT_MS` | `5000` | espera máxima por um lock; estourar é falha transitória (503) |
| `OUTBOX_POLL_INTERVAL_MS` | `1000` | intervalo entre consultas da outbox |
| `OUTBOX_BATCH_SIZE` | `10` | eventos por lote (máx. 100) |
| `OUTBOX_PUBLISH_TIMEOUT_MS` | `5000` | prazo de cada envio ao SQS; a reserva do lote dura 6 vezes este valor |
| `PENDING_REFERENCE_POLL_INTERVAL_MS` | `1000` | intervalo entre consultas de pendências vencidas |
| `PENDING_REFERENCE_BATCH_SIZE` | `10` | pendências por rodada (máx. 100) |
| `PENDING_REFERENCE_RETRY_BASE_MS` / `_MAX_MS` | `5000` / `300000` | backoff `min(base · 2ⁿ, teto)` |
| `PENDING_REFERENCE_MAX_ATTEMPTS` | `10` | tentativas antes de rejeitar (cerca de 25 minutos no total) |

A fila de entrada tem `VisibilityTimeout` de 30 s e redrive para a DLQ após 5 recebimentos (`SQS_MAX_RECEIVE_COUNT`, lida só pelo script `infra/localstack/init-queues.sh`).

## Executando com Docker Compose

```bash
docker compose up -d --build
```

Sobem, nesta ordem de dependência: `postgres`, `localstack` (o init cria as filas), `migrate` (job que aplica as migrations e termina), `api` e `worker`. Para várias instâncias:

```bash
docker compose up -d --build --scale api=3 --scale worker=2
docker compose ps
```

| Serviço | Papel | Porta no host |
|---|---|---|
| `postgres` | PostgreSQL 16 | `5432` |
| `localstack` | SQS (filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo`, `wager-events`) | `4566` |
| `migrate` | `bun run migration:up` e encerra | n/a |
| `api` | HTTP (`src/main.api.ts`); escalável | faixa `3000-3009` mapeada para a `3000` interna |
| `worker` | consumer SQS, publisher da outbox e retrier de `PENDING_REFERENCE` (`src/main.worker.ts`) | nenhuma (a `3100` é interna) |

> **Portas da API.** Com a faixa `3000-3009`, o Docker escolhe a porta de cada réplica ao criá-la e **pode escolher outra ao reiniciar o container**. Consulte sempre `docker compose ps` para saber em qual porta cada instância está. Nos exemplos abaixo, `PORT` é uma dessas portas.

Para acompanhar os logs e encerrar:

```bash
docker compose logs -f api worker
docker compose down        # remove os containers; NÃO use -v se quiser manter os dados
```

`docker compose down -v` apaga também o volume de dados do PostgreSQL.

### Migrations

O serviço `migrate` já as aplica no `up`. Para rodar à mão a partir do host (com o PostgreSQL no ar, por exemplo `docker compose up -d postgres`):

```bash
bun install --frozen-lockfile
bun run migration:up      # aplica todas as pendentes
bun run migration:down    # reverte somente a última aplicada
```

Cada migration é versionada e tem `up` e `down`. Os dois scripts leem `DATABASE_URL` do ambiente ou do `.env`.

## Usando a API

Todos os valores monetários trafegam como `{ "amount": "25.00", "currency": "BRL" }`: `amount` é **string** com exatamente 2 casas (`"25"`, `"25.5"`, `"25.001"`, números JSON e notação científica são recusados com 400).

Os exemplos abaixo foram executados contra a própria aplicação; os ids das respostas mudam a cada execução. Substitua `PORT` pela porta de uma instância da API.

```bash
API=http://localhost:PORT

# 1) Abrir uma wallet
curl -s -X POST $API/wallets -H 'Content-Type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
# 201 {"id":"01a197c0-44c8-74fe-82ec-89f200cccf33","playerId":"0192f28f-…","balance":{"amount":"1000.00","currency":"BRL"},"version":1}

WALLET=01a197c0-44c8-74fe-82ec-89f200cccf33   # use o id devolvido

# 2) Apostar
curl -s -X POST $API/wagering/transactions \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"'$WALLET'","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
# 201 {"transactionId":"01a197c0-4834-…","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}
```

Reenviar exatamente o mesmo comando devolve `200` com `"idempotentReplay": true` e o saldo daquele momento (`975.00`), sem novo efeito.

## Endpoints HTTP

| Método e rota | Descrição |
|---|---|
| `POST /wallets` | abre uma wallet |
| `GET /wallets/:walletId` | consulta a wallet |
| `GET /wallets/:walletId/ledger?limit=&cursor=` | lista o ledger com cursor opaco (`limit` de 1 a 200, padrão 50) |
| `POST /wallets/:walletId/reconciliation` | compara o saldo guardado com o ledger |
| `POST /wagering/transactions` | submete uma operação (exige `Idempotency-Key`) |
| `GET /wagering/transactions/:transactionId` | consulta uma transação pelo id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | consulta pelo id do provedor |
| `GET /health/live` | liveness |
| `GET /health/ready` | readiness (PostgreSQL e filas) |
| `GET /metrics` | métricas no formato Prometheus |

Ids de wallet, player e transação são UUIDs (maiúsculas são normalizadas). `providerId`, `externalTransactionId`, `roundId`, `gameId` e a `Idempotency-Key` são textos de 1 a 255 caracteres sem caracteres de controle. O provider `internal` é reservado. Campos desconhecidos no corpo são recusados com 400.

### `POST /wallets`

Corpo: `{ "playerId": "<uuid>", "initialBalance": { "amount": "1000.00", "currency": "BRL" } }`. Existe no máximo uma wallet por par (`playerId`, moeda). Um saldo inicial positivo gera, na mesma transação SQL, a transação interna `OPENING` e o lançamento `CREDIT` correspondente.

- `201` com `{ id, playerId, balance, version }` (a `version` começa em 1).
- `409 WALLET_ALREADY_EXISTS` para duplicidade.
- `400 INVALID_PAYLOAD` para payload inválido.

### `GET /wallets/:walletId/ledger`

```json
{
  "entries": [
    {
      "id": "01a197c0-4507-71b1-b1e1-a3560dc564e1",
      "transactionId": "01a197c0-4505-7501-9a62-9a98aa2d1cd7",
      "walletVersion": 1,
      "direction": "CREDIT",
      "money": { "amount": "1000.00", "currency": "BRL" },
      "balanceBefore": { "amount": "0.00", "currency": "BRL" },
      "balanceAfter": { "amount": "1000.00", "currency": "BRL" },
      "createdAt": "2026-11-01T15:35:22.568Z"
    }
  ],
  "nextCursor": "Mw"
}
```

A ordem é a do ledger (`seq` crescente). `nextCursor` é `null` na última página; devolva-o como veio em `?cursor=`. Lançamentos novos só aparecem depois do cursor, então nada se repete nem é pulado. Cursor ou `limit` inválidos retornam `400`.

### `POST /wagering/transactions`

Header obrigatório `Idempotency-Key` (ausente ou vazio: `400`). O padrão recomendado é `{providerId}:{externalTransactionId}`, mas qualquer texto válido serve, e a chave tem escopo global.

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "01a197c0-44c8-74fe-82ec-89f200cccf33",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

`kind` aceita `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK` (`OPENING` é interno e recusado). `referenceExternalTransactionId` é obrigatório em `REFUND` e `ROLLBACK`, opcional em `WIN` e `LOSS` e **proibido em `BET`** (enviá-lo em uma `BET` retorna `400`). Uma operação com referência acrescenta o campo ao mesmo payload; por exemplo, um `REFUND` da `BET` acima:

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "refund-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "01a197c0-44c8-74fe-82ec-89f200cccf33",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "REFUND",
  "money": { "amount": "25.00", "currency": "BRL" },
  "referenceExternalTransactionId": "transaction-123"
}
```

(o `Idempotency-Key` é `provider-a:refund-123`; o valor deve ser igual ao da `BET` referenciada.)

Resposta (`status` é o da transação; `balance` é o saldo observado na decisão; `failureCode` só aparece em rejeições):

```json
{ "transactionId": "01a197c0-4834-728f-836b-6c5d3d6bf192", "status": "PROCESSED",
  "balance": { "amount": "975.00", "currency": "BRL" }, "idempotentReplay": false }
```

| HTTP | Situação |
|---|---|
| `201` | processada agora (`PROCESSED`, `idempotentReplay: false`) |
| `200` | replay de uma operação já processada, com o resultado e o saldo originais |
| `202` | aceita e aguardando a referência (`PENDING_REFERENCE`); sem `balance` |
| `422` | rejeitada por regra de negócio (`status: REJECTED` com `failureCode`), também no replay; ou wallet inexistente (`WALLET_NOT_FOUND`, sem persistir) |
| `409` | conflito de idempotência (`IDEMPOTENCY_KEY_REUSED`): mesma chave com payload diferente, ou mesmo `externalTransactionId` com outra chave |
| `400` | payload inválido ou header ausente (`INVALID_PAYLOAD`, com `issues`) |
| `503` | falha transitória (`TEMPORARILY_UNAVAILABLE`, com `Retry-After: 1`): o provedor pode reenviar |
| `500` | erro interno; um replay de uma transação `FAILED` também devolve 500, com o estado auditável |

Exemplo de rejeição (`422`):

```json
{ "transactionId": "01a197c0-4f3c-71b1-a396-67af4ce90fbd", "status": "REJECTED",
  "balance": { "amount": "975.00", "currency": "BRL" },
  "failureCode": "INSUFFICIENT_FUNDS", "idempotentReplay": false }
```

Os erros que não são resultado de uma transação usam sempre `{ "code": "…", "message": "…" }` (a validação acrescenta `issues`):

```json
{ "code": "IDEMPOTENCY_KEY_REUSED", "message": "the Idempotency-Key was already used with a different payload" }
```

#### Códigos de falha (`failureCode`)

| Código | Quando | O provedor deve |
|---|---|---|
| `INSUFFICIENT_FUNDS` | `BET` sem saldo | reenviar depois, como nova transação |
| `REVERSAL_INSUFFICIENT_FUNDS` | `ROLLBACK` deixaria o saldo negativo | tratamento operacional |
| `REFERENCE_NOT_FOUND` | a referência não apareceu até o limite de tentativas | corrigir ou desistir |
| `REFERENCE_NOT_PROCESSED` | a referência existe, mas terminou `REJECTED` ou `FAILED` | desistir |
| `REFERENCE_KIND_INVALID` | tipo da referência não permitido | corrigir o payload |
| `REFERENCE_MISMATCH` | provider, player, wallet, moeda ou rodada diferem da referência | corrigir o payload |
| `AMOUNT_MISMATCH` | valor da reversão difere do da referência | corrigir o payload |
| `ALREADY_REVERSED` | a operação original já tem uma reversão aplicada | desistir |
| `PLAYER_WALLET_MISMATCH` | a wallet não pertence ao player informado | corrigir o payload |
| `CURRENCY_MISMATCH` | moeda da operação difere da da wallet | corrigir o payload |
| `BALANCE_LIMIT_EXCEEDED` | o crédito ultrapassaria o limite de `NUMERIC(20,2)` | tratamento operacional |
| `INTERNAL_ERROR` | só em `FAILED` (erro permanente de infraestrutura) | contatar o suporte e usar novo `externalTransactionId` |

### `POST /wallets/:walletId/reconciliation`

Compara, em uma única consulta (mesmo instante), o saldo guardado com a soma assinada do ledger. **Nunca corrige**: divergência é logada, contabilizada em `wallet_reconciliation_divergences_total` e sinalizada na resposta (`200`; `404` se a wallet não existe).

```json
{ "walletId": "01a197c0-44c8-74fe-82ec-89f200cccf33",
  "storedBalance": { "amount": "975.00", "currency": "BRL" },
  "calculatedBalance": { "amount": "975.00", "currency": "BRL" },
  "difference": { "amount": "0.00", "currency": "BRL" },
  "consistent": true, "checkedEntries": 6 }
```

### Consultas de transação

`GET /wagering/transactions/:transactionId` e `GET /providers/:providerId/wagering/transactions/:externalTransactionId` devolvem `{ id, providerId, externalTransactionId, walletId, playerId, roundId, gameId, kind, money, status, referenceExternalTransactionId, referenceTransactionId, failureCode, balance, attempts, nextAttemptAt, createdAt, processedAt }`. Inexistente: `404 TRANSACTION_NOT_FOUND`; id malformado: `400`.

## Tipos de transação

| Tipo | Efeito no saldo | Ledger | Regras |
|---|---|---|---|
| `BET` | débito | 1 `DEBIT` | rejeitada com `INSUFFICIENT_FUNDS` se o saldo não cobrir |
| `WIN` | crédito | 1 `CREDIT` | referência opcional e, se vier, deve ser uma `BET` da mesma rodada; o valor é livre |
| `LOSS` | nenhum | nenhum | registra o resultado; a `version` da wallet não muda; aceita valor `0.00`; referência opcional (`BET`) |
| `REFUND` | crédito | 1 `CREDIT` | referência obrigatória a uma `BET`; valor igual ao dela |
| `ROLLBACK` | o inverso da referência | 1 entrada invertida | referência obrigatória a `BET` (credita), `WIN` ou `REFUND` (debitam); valor igual ao da referência |

Regras comuns de referência: resolvida por `(providerId, referenceExternalTransactionId)`; precisa ser do mesmo provider, player, wallet, moeda e rodada. Uma operação original recebe **uma única** reversão financeira (`REFUND` ou `ROLLBACK`, nunca as duas). Se a referência ainda não existe, a transação fica `PENDING_REFERENCE` (`202`) e um worker a reprocessa com backoff exponencial; esgotadas as tentativas, vira `REJECTED` com `REFERENCE_NOT_FOUND` e um evento é publicado.

Estados: `PENDING → PENDING_REFERENCE → PROCESSED | REJECTED | FAILED`. Os três últimos são terminais, também no banco.

## Processamento por SQS

O worker consome `wager-transactions.fifo` com o mesmo caso de uso da API. Envelope (campos desconhecidos são recusados):

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-11-01T15:00:00.000Z",
  "data": {
    "providerId": "provider-a", "externalTransactionId": "transaction-124",
    "idempotencyKey": "provider-a:transaction-124",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1", "walletId": "01a197c0-44c8-74fe-82ec-89f200cccf33",
    "roundId": "round-987", "gameId": "fortune-chimp", "kind": "BET",
    "money": { "amount": "5.00", "currency": "BRL" }
  }
}
```

Para enviar uma mensagem de teste (a fila é FIFO sem deduplicação por conteúdo, então `--message-group-id` e `--message-deduplication-id` são obrigatórios; o exemplo é para bash):

```bash
docker compose exec -T localstack awslocal sqs send-message \
  --queue-url http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/wager-transactions.fifo \
  --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-11-01T15:00:00.000Z","data":{"providerId":"provider-a","externalTransactionId":"transaction-124","idempotencyKey":"provider-a:transaction-124","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"01a197c0-44c8-74fe-82ec-89f200cccf33","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"5.00","currency":"BRL"}}}' \
  --message-group-id 01a197c0-44c8-74fe-82ec-89f200cccf33 --message-deduplication-id msg-123
```

Depois consulte o resultado com `GET /providers/provider-a/wagering/transactions/transaction-124`.

| Resultado | Ação do consumer |
|---|---|
| processada, pendente de referência, replay, duplicata de inbox ou rejeição de negócio | `DeleteMessage` (ack) **depois** do commit |
| erro transitório ou inesperado | não apaga; adia a próxima entrega (`ChangeMessageVisibility`, backoff até 300 s); a redrive policy envia à DLQ após 5 recebimentos |
| erro permanente (JSON ou schema inválido, `messageId` repetido com payload diferente, conflito de idempotência, wallet inexistente, `FAILED`) | envia explicitamente à DLQ (com o atributo `failureReason`) e só então apaga a original |

Eventos de integração publicados em `wager-events`: `WagerTransactionProcessed` (inclusive `LOSS` e `OPENING`), `WagerTransactionRejected`, `WagerTransactionPendingReference` e `WalletBalanceChanged` (somente quando o saldo muda). Cada evento tem `eventId` estável, de modo que um consumidor deduplica por ele.

## Testes

A maioria precisa de PostgreSQL e LocalStack reais. Suba-os e use sempre bancos e filas descartáveis (os testes criam e removem os próprios `wagering_test_*` e filas de teste; não tocam no banco de desenvolvimento):

```bash
docker compose up -d postgres localstack
bun install --frozen-lockfile
```

| Comando | Conteúdo |
|---|---|
| `bun run typecheck` | `tsc --noEmit` |
| `bun run test:unit` | unitários (`Money`, `Wallet`, regras de cada tipo, estados, hash de payload, filtro de erros etc.), sem IO |
| `bun run test:architecture` | regras de dependência entre camadas e módulos, e domínio puro |
| `bun run test:integration` | PostgreSQL e LocalStack reais: migrations (`up`, `down`, `up`), constraints atacadas por SQL direto, atomicidade com falha injetada, inbox, outbox, consumer SQS, retry e DLQ, retrier de pendências |
| `bun run test:e2e` | API HTTP real: contratos, status, paginação, reconciliação, health e métricas |
| `bun run test:concurrency` | paralelismo real: 50 BETs idênticas, 100/80/80, wallets distintas, **três ou mais processos independentes**, worker morto entre commit e ack, dois publishers, referência fora de ordem, reinício |
| `bun run test` | tudo, em uma execução (`bun test --timeout 60000`) |

Notas:

- `test:concurrency` inicia processos reais da API e do worker (`Bun.spawn`) e leva alguns minutos.
- Os dois testes de **SIGTERM** (encerramento gracioso do worker) só rodam em Linux e macOS; no Windows o sinal encerra o processo imediatamente, então são ignorados (`skip`). Para executá-los em Windows, use WSL ou um container Linux com acesso ao PostgreSQL e ao LocalStack.
- Todo teste financeiro termina verificando a invariante `saldo da wallet == soma assinada do ledger` e `version == maior wallet_version do ledger`.
- Os testes de spike em `test/spike` são verificações de pilha usadas no início do projeto; entram no `bun run test`, mas não têm script próprio.

## Health e métricas

```bash
curl -s http://localhost:PORT/health/live     # {"status":"ok"} enquanto o processo responde (não consulta dependências)
curl -s http://localhost:PORT/health/ready
# {"status":"ok","checks":{"postgres":{"status":"up","latencyMs":3},"sqs":{"status":"up","latencyMs":15},"sqsEvents":{"status":"up","latencyMs":17}}}
curl -s http://localhost:PORT/metrics
```

`/health/ready` devolve `200` quando PostgreSQL, a fila de entrada e a fila de eventos respondem, e `503` com o relatório se alguma falhar (apenas categorias genéricas: `timeout` ou `unavailable`; o detalhe vai ao log interno). Os endpoints de health e de métricas são públicos.

O worker expõe o mesmo `/health/live`, `/health/ready` e `/metrics` na porta interna `3100`, que o Compose não publica:

```bash
docker compose exec worker bun -e "fetch('http://localhost:3100/metrics').then(r => r.text()).then(console.log)"
```

Métricas (cada processo expõe as suas, e elas zeram quando o processo reinicia):

| Métrica | Observação |
|---|---|
| `wager_transactions_total{source,kind,status}` | respostas decididas por origem (`http`, `sqs`, `retry`), inclusive replays |
| `wager_duplicates_total{type}` | `idempotent_replay` e `inbox_message` |
| `wager_idempotency_conflicts_total` | chave ou id externo reaproveitados com outro payload |
| `wager_retries_total{kind}` | `sqs_redelivery`, `outbox_publish`, `pending_reference` |
| `wager_dlq_messages_total{reason}` e `wager_dlq_depth` | mensagens movidas à DLQ e profundidade atual dela (worker) |
| `wager_lock_conflicts_total{type}` | `lock_timeout`, `deadlock`, `unique_collision` |
| `wager_wallet_lock_wait_seconds` | histograma da espera pelo lock da wallet |
| `wager_processing_duration_seconds{source}` | histograma de latência do processamento |
| `wager_outbox_lag_seconds`, `wager_outbox_pending`, `wager_outbox_published_total` | atraso do evento pendente mais antigo, pendentes e publicados (worker) |
| `wallet_reconciliation_divergences_total` | divergências encontradas pela reconciliação |

Os logs são JSON, um objeto por linha, com `correlationId` e, quando aplicável, `messageId`, `transactionId`, `walletId` e `providerId`. Apenas identificadores são registrados: nenhum valor monetário, `playerId`, payload completo ou credencial. A API aceita o header `X-Correlation-Id` (valores simples de até 128 caracteres) e o devolve na resposta; sem ele, gera um.

## Limitações conhecidas e decisões relevantes

- **Sem autenticação.** Não há Identity Provider. O ponto de extensão é o `ProviderAuthGuard` (`src/shared/presentation/provider-auth.guard.ts`), um guard que aceita tudo e está aplicado a todos os controllers de negócio; health e métricas ficam fora dele. Em produção, o guard validaria o token e compararia o provider autenticado com o `providerId` da requisição. As mensagens SQS são tratadas como canal interno confiável, mas continuam sujeitas às mesmas validações de domínio.
- **Entrega at-least-once dos eventos.** A publicação na outbox pode repetir um evento (queda entre o envio ao SQS e a confirmação no banco). O `eventId` é estável, e a deduplicação cabe ao consumidor. Nenhum componente deste repositório consome `wager-events`.
- **A outbox não tem rotina de limpeza**: eventos publicados permanecem na tabela.
- **Bloqueio de grupo no FIFO.** Em uma fila FIFO, uma mensagem em retry impede as seguintes do mesmo grupo. Por isso `PENDING_REFERENCE` é persistida e recebe ack, em vez de reentregar a mensagem. A correção financeira não depende da ordem do broker.
- **Latência da pendência.** Depois que a referência chega, a reversão pendente só é liquidada na próxima tentativa agendada do retrier (no máximo 5 minutos com os valores padrão), não no mesmo instante.
- **Reversão única.** Uma operação original só recebe uma reversão financeira (`REFUND` ou `ROLLBACK`). É mais estrito que "não reverter duas vezes pelo mesmo tipo" e protege contra crédito duplicado. Consequência: uma `BET` estornada por `REFUND` que sofreu `ROLLBACK` não pode ser estornada de novo. Reversão parcial não existe.
- **`WIN` e `LOSS` só referenciam `BET`** (quando informam referência).
- **Valor `0.00`** só é aceito em `LOSS`. O limite é 18 dígitos inteiros mais 2 decimais (`NUMERIC(20,2)`); um crédito além dele é rejeitado com `BALANCE_LIMIT_EXCEEDED`.
- **Wallet inexistente**: na API é `422 WALLET_NOT_FOUND` sem persistir; na fila a mensagem vai à DLQ, para não ser perdida por um ack.
- **`FAILED`** é reservado a erro permanente de infraestrutura em uma transação válida; é terminal e o provedor precisa de um novo `externalTransactionId`.
- **Métricas por processo**, sem agregação nem persistência; `wager_dlq_depth` e as métricas da outbox só existem no worker.
- **Sem teste de carga** (`test:load` não existe) e sem OpenTelemetry ou dashboard.
- **Ambiente de testes de concorrência** exige Linux, macOS ou WSL para exercitar o `SIGTERM`.

Registros de decisão adicionais (em português) estão em [`docs/decisions/`](docs/decisions). Cada um preserva o retrato da época em que foi escrito, com notas onde algo foi superado depois; em caso de divergência, vale o código e o [ARCHITECTURE.md](ARCHITECTURE.md).

## Estrutura do repositório

```
src/
  main.api.ts · main.worker.ts          raízes de composição (API e worker)
  api.module.ts · worker.module.ts
  app/
    wallet/                             Wallet, ledger, consultas, reconciliação
    wagering/                           WagerTransaction, processamento, consumer SQS, retrier
    messaging/                          Inbox, Outbox, eventos, publisher
    health/                             liveness e readiness
  shared/                               Money, erros, configuração, observabilidade
  database/                             migrations, unit of work, tradução de erros do PostgreSQL
infra/localstack/init-queues.sh         cria as filas e a redrive policy
test/                                   unit · integration · e2e · architecture · concurrency · support
docs/decisions/                         registros de decisão
```
