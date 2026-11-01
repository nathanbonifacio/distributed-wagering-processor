# 0007 — Transactional Outbox

Status: implementada na Etapa 8 · Data: 31/10/2026.
Destina-se às seções de mensageria, garantias de entrega e limitações do futuro `ARCHITECTURE.md`.

## Destino e envelope

- **Fila:** `wager-events`, standard, configurável em `SQS_EVENTS_QUEUE_NAME`. O README não define o destino.
  `wager-transactions.fifo` é a fila de **entrada** (seção 10): publicar nela faria o consumer receber os próprios
  eventos.
- **Corpo:** o envelope `IntegrationEvent.toJSON()` da seção 11. `{ messageId, type, occurredAt, data }` é o contrato
  de entrada.
- **FIFO:** se a fila configurada terminar em `.fifo`, `MessageGroupId` é o `aggregateId` e `MessageDeduplicationId` é
  o `eventId`. A correção financeira não depende disso.

## Publicação sem transação distribuída

1. Transação curta: `FOR UPDATE SKIP LOCKED` nos eventos vencidos e `next_attempt_at` adiado pelo prazo da reserva.
2. Fora de transação: envio ao SQS.
3. Transação curta: grava `published_at`, ou tentativa, backoff e `last_error`.

**Reserva em vez de lock durante o envio:** um SQS lento não prende linhas nem conexões do pool, que também atende as
operações financeiras. O custo é que uma reserva vencida durante um envio lento gera duplicata, permitida pela entrega
at-least-once. A reserva dura 6 vezes o prazo de envio.

## Garantias

| Situação | Resultado |
|---|---|
| Rollback da operação | O evento some junto |
| Antes do commit | O publisher não enxerga a linha |
| SQS recusa ou fora do ar | O evento fica pendente, com backoff; a operação financeira não é afetada |
| Queda antes de publicar | A reserva vence e outra instância publica |
| Queda entre o SQS e o PostgreSQL | Nova publicação, com o mesmo `eventId` |
| Tentativa atrasada que falhou | Não reabre um evento já publicado |

**O consumidor deduplica pelo `eventId`.** Não se promete exactly-once. Na fila standard, a ordem não é garantida, e
`walletVersion` permite ordenar.

## Backoff

`min(1s·2^n, 5min)`, sem limite de tentativas: o README proíbe perder eventos confirmados, e `attempts` e `last_error`
tornam o caso visível. `last_error` guarda só o nome do erro.

## Limitações

- Sem rotina de limpeza da outbox.
- Sem métricas de outbox lag (Etapa 12).
- Um evento que o transporte recuse para sempre segue em retentativa a cada 5 minutos, sem DLQ própria.
- A queda de processos reais é testada na Etapa 13; aqui, o fluxo é interrompido no ponto exato.
