# 0008 — Consumer SQS e inbox

Status: implementada · Data: 31/10/2026.
Consolidada nas seções 11, 12 e 13 do `ARCHITECTURE.md`.

## Atomicidade

`ProcessWagerTransaction.execute(command, delivery?)` é o mesmo caso de uso da API. Com `delivery`, o inbox entra na
mesma transação de transação, saldo, ledger e outbox. Sem commit, nada existe, nem o inbox: uma linha do inbox
confirmada sempre significa processamento confirmado, e nenhuma mensagem fica presa.

Ordem de lock: inbox, depois wallet, sempre. Quem espera por um `messageId` não segura wallet, então não há ciclo.

## Duas defesas

| Situação | Inbox | Idempotency key | Resultado |
|---|---|---|---|
| Mesmo `messageId`, mesmo payload | Já existe | Replay | Ack, sem efeito |
| Mesmo `messageId`, outro payload | Conflito | — | DLQ, `INBOX_MESSAGE_CONFLICT` |
| Outro `messageId`, mesmo comando | Nova linha | Replay | Ack, sem efeito |
| Mesma chave, outro payload | Desfeito | Conflito | DLQ, `IDEMPOTENCY_KEY_REUSED` |

## Classificação

| Resultado do processamento | Ação |
|---|---|
| `PROCESSED`, `REJECTED`, `PENDING_REFERENCE`, replay | Ack depois do commit |
| Erro transitório ou inesperado | Sem ack; visibilidade `min(5s·2^(n-1), 5min)`; a redrive policy (`maxReceiveCount = 5`) leva à DLQ |
| JSON ou schema inválido, OPENING externo, regra de criação | DLQ, `INVALID_MESSAGE` |
| Conflitos e `WALLET_NOT_FOUND` | DLQ, com o código |
| Erro permanente de infraestrutura, ou replay de `FAILED` | `FAILED` registrado; DLQ, `INTERNAL_ERROR` |

**Interpretações:**

- **Conflito vai para a DLQ, não para ack.** O conflito desfaz a transação e não deixa registro; um ack perderia a
  mensagem em silêncio, e o README proíbe descartar sem rastro.
- **Erro inesperado é tentado de novo**, com limite: pode ser passageiro, e a redrive policy impede o laço infinito.

## Fila e ordem

Consome só a fila de entrada; eventos vão para `wager-events`. Dentro de um lote, cada grupo é processado em ordem, e
grupos diferentes, em paralelo. Depois de uma falha, o resto do grupo volta para a fila. É otimização: a correção vem
do lock e das constraints. **Trade-off do FIFO:** uma mensagem em retry bloqueia o próprio grupo; por isso a
`PENDING_REFERENCE` é persistida e recebe ack.

## Encerramento

Em SIGTERM ou SIGINT: interrompe o long polling, conclui o que está em andamento até
`SQS_CONSUMER_SHUTDOWN_TIMEOUT_MS` (8 s, abaixo dos 10 s do `docker stop`) e devolve a visibilidade do que não começou. Vencido o prazo, o que ainda estava em andamento também é devolvido (ver 0011).
Sem commit não há ack, então o que não terminar volta para a fila.

## Limitações

- A visibilidade não é renovada durante o processamento. Se uma mensagem passar dos 30 s da fila, pode ser entregue
  a outro consumidor; o efeito não se repete.
- Neste registro o reprocessamento de `PENDING_REFERENCE` ainda não existia (implementado depois; ver 0009).
- Aqui o ponto da falha é reproduzido no mesmo processo; a queda real de processos foi testada depois (ver 0011).
- A DLQ não tem rotina de reprocessamento; reenviar é manual.
