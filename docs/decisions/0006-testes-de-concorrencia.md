# 0006 — Testes de concorrência

Status: implementada na Etapa 7 · Data: 31/10/2026.
Destina-se às seções de concorrência, testes e limitações do futuro `ARCHITECTURE.md`.

## Como a concorrência é provocada

Três instâncias independentes da API real (`ApiModule`), cada uma com o próprio pool, sobre um PostgreSQL real e
descartável. Rodam no mesmo processo; a prova com processos separados é da Etapa 13.

- **Barreira:** outra sessão segura a linha da wallet, os pedidos saem, e `pg_stat_activity` confirma que as sessões
  estão de fato esperando o lock antes de soltar. Não define quem vence.
- **Corrida livre:** pedidos simultâneos, sem coordenação, repetidos por 20 rodadas.

As asserções leem o banco e valem para qualquer ordem de serialização. O helper
`assertFinancialInvariants` reconstrói o saldo a partir do ledger com `Money`, sem passar pelo código de produção.

## Falhas injetadas

Sem nenhum gancho em produção: triggers criados só no banco descartável fazem o PostgreSQL recusar o comando no
meio da transação, com o SQLSTATE escolhido, e `pg_terminate_backend` derruba sessões reais.

## Defeitos encontrados e corrigidos

**Conexões perdidas após queda de sessão (`dropped-connection-release.ts`).** No Kysely 0.29.6, usado pelo MikroORM,
a conexão de uma transação só volta ao pool depois que o `COMMIT` ou o `ROLLBACK` dão certo. Com a conexão morta os
dois falham, e a vaga se perde. Medido: na 10ª queda a instância passou a responder 503 para sempre, com o banco
saudável, e o encerramento travava. Agora a conexão encerrada enquanto emprestada volta ao pool como quebrada.
Não houve efeito financeiro: o PostgreSQL desfaz a transação da sessão derrubada.

**`statement_timeout` tratado como erro definitivo.** O SQLSTATE 57014 respondia 500. Agora é transitório: 503.

## Limitações

- **Saturação do pool:** uma wallet disputada pode ocupar todas as conexões de uma instância (10 por padrão), porque
  a sessão fica presa ao lock. Outra wallet na mesma instância espera uma conexão livre, e não o lock dela. Outras
  instâncias seguem normalmente. A espera é limitada por `DB_LOCK_TIMEOUT_MS` e `DB_CONNECT_TIMEOUT_MS`; o excesso
  vira 503, nunca um resultado errado.
- **Rede travada sem encerrar a conexão:** com a queda abrupta sem FIN, o `ROLLBACK` expira e a vaga só volta quando
  o sistema operacional encerrar o socket. Não foi testado.

## Oito cenários da seção 13 do README

Todos são obrigatórios para a entrega final; a divisão é só organizacional.

| Cenário | Etapa | Situação |
|---|---|---|
| 50 apostas idênticas em paralelo | 7 | Comprovado |
| Duas apostas disputando saldo | 7 | Comprovado |
| Wallets distintas em paralelo | 7 | Comprovado |
| Três ou mais processos simultâneos | 13 | Pendente (hoje, instâncias no mesmo processo) |
| Worker morto após o commit e antes do ack | 9 e 13 | Pendente |
| Dois publishers na mesma outbox | 8 e 13 | Pendente |
| REFUND ou ROLLBACK antes da referência | 7 e 10 | Parcial: falta o reprocessamento |
| Reinício do serviço e consistência final | 13 | Pendente |

## Interpretação adicional

REFUND e ROLLBACK da mesma operação original são mutuamente exclusivos. É mais estrito que a regra 4 do README, que
só proíbe repetir o tipo, e impede crédito duplicado, que a seção 3 proíbe.
