# 0010 — Observabilidade

Status: implementada · Data: 01/11/2026.
Consolidada na seção 16 do `ARCHITECTURE.md` e na seção "Health e métricas" do `README.md`.

## Logs

- Uma linha JSON por registro, escrita pelo pino a partir do `Logger` do Nest (`JsonLogger`): todo log que já
  existia passou a sair em JSON sem mudar de chamada. Sem transport e sem worker thread, que o Bun não precisa.
- O contexto (`correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`) viaja em
  `AsyncLocalStorage` e entra sozinho em cada registro. Na HTTP, o `X-Correlation-Id` do chamador é aceito só
  se for um identificador simples, e volta na resposta; na fila, o `messageId` do envelope é a correlação; no
  retrier, o id da transação.
- O mesmo `correlationId` vai para os eventos da outbox, ligando log, requisição e evento.
- Sem dados sensíveis: o código só loga identificadores e códigos. Como rede de segurança, o pino censura
  campos como `money`, `amount`, `balance` e `payload` em qualquer profundidade. Um erro sai só pelo nome,
  sem mensagem e sem stack, porque a mensagem pode trazer SQL ou valores.

## Métricas

`prom-client` com um registro por processo (nunca o global) e `GET /metrics` em texto, sem exigir servidor.

| Métrica | Cobre |
|---|---|
| `wager_transactions_total{source,kind,status}` | transações por status |
| `wager_duplicates_total{type}` | replays de idempotência e mensagens já recebidas |
| `wager_idempotency_conflicts_total` | chave reutilizada com outro payload |
| `wager_retries_total{kind}` | pendentes, redelivery do SQS e publicação da outbox |
| `wager_dlq_messages_total{reason}` e `wager_dlq_depth` | DLQ: envios deste processo e a profundidade real |
| `wager_lock_conflicts_total{type}` e `wager_wallet_lock_wait_seconds` | `lock_timeout`, `deadlock`, `unique_collision` e a espera pelo lock |
| `wager_outbox_lag_seconds`, `wager_outbox_pending`, `wager_outbox_published_total` | atraso e estado da outbox |
| `wager_processing_duration_seconds{source}` | latência de processamento |
| `wallet_reconciliation_divergences_total` | divergências encontradas |

- Os gauges (lag da outbox, profundidade da DLQ) só leem na coleta, por consultas baratas, e uma leitura que
  falha não derruba as demais métricas. Eles existem no `/metrics` do worker.
- A telemetria do processamento financeiro passa por um port (`WagerTelemetry`), para a camada de aplicação
  não depender de log nem de métrica. Sem o módulo de observabilidade, o port é um no-op.
- "Conflito de lock" foi definido como lock timeout, deadlock e colisão de unique entre wallets. A espera
  normal pelo lock aparece no histograma, e uma espera de 100 ms ou mais também vira linha de log.

## Limitações

- As métricas são por processo: quem coleta soma as instâncias. O lag e a profundidade da DLQ refletem o
  banco e a fila inteiros, então várias instâncias do worker reportam o mesmo valor.
- `/metrics` não exige autenticação e não deve ficar exposto fora da rede interna.
- Não há OpenTelemetry nem dashboard (opcionais no README).
