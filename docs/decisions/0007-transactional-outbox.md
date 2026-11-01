# 0007 — Transactional Outbox

Status: implementada · Data: 31/10/2026.
Consolidada nas seções 10 e 13 do `ARCHITECTURE.md`. Veja também a atualização no fim deste registro.

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
- Neste registro não havia métricas de outbox lag (adicionadas depois; ver 0010).
- Um evento que o transporte recuse para sempre segue em retentativa a cada 5 minutos, sem DLQ própria.
- Aqui a queda é simulada interrompendo o fluxo no ponto exato; a queda de processos reais foi testada depois (ver 0011).

## Atualização posterior: resultado de uma reserva vencida

Registrada depois da implementação inicial, a partir de uma revisão de concorrência do publisher. **Substitui o passo 3**
descrito acima; o restante deste registro continua valendo.

O problema: se uma publicação demorava mais que a reserva, outra instância assumia o evento, e o resultado atrasado da
primeira instância podia sobrescrever o agendamento e a contagem de tentativas da segunda. Só gerava duplicidade
(permitida pelo at-least-once), nunca perda de evento nem reabertura de um evento publicado, mas desfazia o backoff.

- O resultado de cada tentativa é gravado em uma transação que **trava as linhas** (`FOR UPDATE`, em ordem de `id`) e decide
  sobre o **estado atual** da linha, não sobre a cópia reservada.
- O `next_attempt_at` serve de **token** da reserva: uma nova reserva só ocorre quando `agora >= next_attempt_at` e grava
  `agora + lease`, estritamente maior (por isso `PublishOutboxBatch` exige `leaseMs` inteiro positivo). Sem coluna nem
  migration novas.
- Falha de uma reserva já substituída só incrementa `attempts` e guarda o erro, sem alterar o agendamento do novo dono;
  falha da reserva vigente agenda o backoff sobre as tentativas gravadas; sucesso, mesmo atrasado, grava `published_at` (a
  primeira data prevalece); um evento publicado nunca é reaberto.
- `OutboxRepository.save` é um *compare-and-set*: só grava se `attempts` e `next_attempt_at` ainda forem os lidos e o evento
  não estiver publicado (devolve `false` caso contrário), e recusa mensagens nunca lidas da tabela.

Limitação residual: um relógio que recue mais que a reserva, e um instante exato, poderiam fazer um resultado atrasado
parecer vigente. O efeito também se limita a duplicidade. Fechar isso por completo exigiria uma coluna de token.
