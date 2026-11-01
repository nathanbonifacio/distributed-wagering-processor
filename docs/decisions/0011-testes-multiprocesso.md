# 0011 — Testes multiprocesso e tolerância a falhas

Status: implementada · Data: 01/11/2026.
Consolidada nas seções 13 e 15 do `ARCHITECTURE.md` e na seção "Testes" do `README.md`.

## Como os testes provam as propriedades distribuídas

- Cada cenário sobe processos reais do sistema operacional (`bun run src/main.api.ts` e
  `src/main.worker.ts`), cada um com o próprio pool, a própria memória e o próprio MikroORM. O que eles
  compartilham com o teste é só o PostgreSQL e o SQS, ambos reais. Instâncias no mesmo processo (as de
  `startApiCluster`) continuam úteis para testes de integração, mas não valem como prova distribuída.
- A morte é um sinal de verdade: `SIGKILL` para "o processo caiu" e `SIGTERM` para o desligamento.
- Esperas são sempre por estado observável, com prazo, nunca por `sleep` fixo. A exceção são verificações
  negativas curtas, como "o processo ainda está vivo 600 ms depois do SIGTERM".
- Cada teste que depende de outbox, inbox ou contagens usa um banco novo, para que dados de outro teste não
  entrem na conta.
- O invariante final (`saldo == soma do ledger`, versão coerente) é conferido por SQL direto, sem passar pelo
  código de produção, em todos os cenários.

## Matar um processo real em um ponto exato

Sem nenhum gancho no código de produção: um proxy TCP (`sqs-gate`) fica entre o worker e o SQS e consegue
reter a próxima chamada de uma ação, como `DeleteMessage` ou `SendMessage`. Quando a chamada chega, o teste é
avisado e mata o processo naquele instante.

- `DeleteMessage` retido: o worker já confirmou a transação e ainda não confirmou a mensagem. O teste confere
  que o commit existe (saldo, ledger, inbox), mata o worker e deixa outro processo receber a redelivery, que
  vira replay sem um segundo efeito.
- `SendMessage` retido: o publisher reservou um lote da outbox e morre enquanto envia. Outro processo publica
  tudo depois que a reserva vence, e nenhum evento se perde.

## Cenários cobertos (README, seção 13)

1. A mesma BET 50 vezes em paralelo, por 3 processos de API: um único débito.
2. 80 + 80 sobre 100, e 100 / 80 / 80 sobre 100: uma processada, as outras `INSUFFICIENT_FUNDS`, saldo coerente.
3. 18 wallets independentes em paralelo, por 3 processos: ledgers independentes e exatos.
4. 3 processos de API e 2 workers disputando a mesma wallet por HTTP e SQS, com mensagens triplicadas.
5. Worker morto depois do commit e antes do ack, com redelivery sem efeito duplicado.
6. Dois publishers da outbox sem perda, e um publisher morto no meio do envio.
7. REFUND e ROLLBACK antes das referências, atravessando a morte e o reinício do worker.
8. Worker morto no meio de um fluxo de 300 mensagens: o seguinte termina, com um efeito por mensagem.
9. SIGTERM com a mensagem em andamento (conclui, confirma e sai) e com o prazo vencido.

## Problema real encontrado e corrigido

Com o prazo do shutdown vencido, uma mensagem ainda em andamento só reaparecia quando a visibilidade expirava.
O README pede "concluir mensagens em andamento **ou devolver a visibilidade**", e nesse caso não se fazia
nenhuma das duas. Agora o consumer registra as mensagens em andamento e, vencido o prazo, devolve cada uma à
fila (`ChangeMessageVisibility(0)`). Se aquela transação ainda confirmar, a redelivery é um replay: o inbox e a
idempotency key garantem um único efeito. O teste usa visibilidade de 120 s, o que prova que a mensagem voltou
porque o worker a devolveu, e não porque o tempo passou.

## Comportamentos que valem registro

- O Nest conclui o shutdown e então relança o sinal, então o código de saída após um SIGTERM limpo é 143
  (128 + SIGTERM), e não 0.
- O tempo para sair com uma mensagem presa é limitado pelo prazo do shutdown mais o `lock_timeout` da transação
  que estava presa (5 s por padrão), porque fechar o pool espera a consulta em andamento.

## Limitações

- Não há teste que derrube o PostgreSQL ou o SQS inteiros com processos reais; a indisponibilidade das duas
  dependências é coberta pelos testes de health e de retry (`health.test.ts` e `wager-consumer.test.ts`), com proxy TCP, dentro do processo.
- O portão reconhece as chamadas do SDK pelo protocolo JSON da AWS (e pelo protocolo de query, como reserva).
  Se o SDK mudar de protocolo, a detecção precisa ser revisada.
- Os testes dependem de tempo real (vários segundos para subir processos); a suíte `test:concurrency` inteira levou de 55 a 75 s nas
  últimas execuções (Windows). Nenhuma espera é fixa, mas um ambiente muito lento pode exigir prazos maiores.
