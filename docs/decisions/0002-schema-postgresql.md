# 0002 — Schema PostgreSQL

Status: implementada na Etapa 3 · Data: 31/10/2026.
Destina-se à futura seção de persistência do `ARCHITECTURE.md`.

## Tabelas

`wallets`, `wager_transactions`, `wallet_ledger_entries`, `inbox_messages` e `outbox_messages`.

**Não há tabela separada de idempotência:** o `UNIQUE (idempotency_key)` em `wager_transactions` cobre a
garantia, já que o replay devolve os dados da própria transação, inclusive `observed_balance`.

## O que o banco garante, e o que não

| Garantia | Mecanismo no schema |
|---|---|
| Saldo não negativo | `CHECK` em `wallets`, `wager_transactions.observed_balance` e no ledger |
| Uma wallet por player e moeda | `UNIQUE (player_id, currency)` |
| Idempotência persistente | `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| Um lançamento por transação e wallet | `UNIQUE (transaction_id, wallet_id)` |
| Um lançamento por versão da wallet | `UNIQUE (wallet_id, wallet_version)` |
| Lançamento na wallet da transação; referência na mesma wallet | FKs compostas para `(id, wallet_id)` |
| Uma reversão por operação original | Índice único parcial em `reference_transaction_id` |
| Ledger imutável | Trigger em `UPDATE`, `DELETE` e `TRUNCATE` |
| Terminal imutável; contrato da operação imutável | Trigger em `UPDATE` e `DELETE` |
| LOSS, REJECTED e FAILED sem lançamento | Trigger no `INSERT` do ledger |
| Dedupe de mensagem | PK `(consumer_name, message_id)` |

**Dependem das próximas etapas, não do schema:**

- **Saldo igual ao ledger:** `wallets.balance` e a soma do ledger só ficam coerentes se forem escritos na
  mesma transação. O `UNIQUE (wallet_id, wallet_version)` detecta parte dos desvios, mas não todos.
- **Sem lost update:** exige `SELECT ... FOR UPDATE` na wallet (Etapas 4 e 5).
- **Regras 2 a 5 do README para player, moeda, rodada e valor da referência:** comparam outra linha. O
  domínio as valida; o banco só garante a wallet.
- **Atomicidade entre inbox, saldo, ledger e outbox:** exige uma única transação SQL.
- **Moeda do lançamento igual à da wallet:** validada pelo domínio. Não foi criada FK composta extra.
- **Saldo observado igual ao saldo real da decisão:** responsabilidade do use case.

## Decisões

- **Sem FK de player e moeda em `wager_transactions`:** `PLAYER_WALLET_MISMATCH` e `CURRENCY_MISMATCH` são
  rejeições auditáveis, então essas linhas precisam poder divergir da wallet.
- **Índice único parcial só para reversões `PROCESSED`:** rejeições não ocupam a vaga; WIN e LOSS não entram;
  o `ROLLBACK` de um `REFUND` tem outra referência e continua permitido. A exclusividade é mais restritiva
  que a regra 4 do README.
- **`next_attempt_at` só em `PENDING_REFERENCE`:** a decisão precisa limpar o campo no mesmo `UPDATE`.
- **Spike:** a migration aplicada fica no histórico e a `Migration20261031000001` remove a tabela.
- **Índice `(wallet_id, created_at)` do PDF não foi criado:** nenhum endpoint do README lista transações por
  wallet, e índice especulativo tem custo em toda escrita.

## Limitação conhecida

`NUMERIC(20,2)` arredonda escala extra silenciosamente (`1.005` vira `1.01`), antes de qualquer `CHECK`. A
proteção é escrever sempre a partir de `Money`, que rejeita mais de 2 casas. Há um teste documentando o
comportamento.

`migrate.ts down` reverte uma migration por vez. O `down` das migrations de criação apaga a tabela e seus
dados: é inerente à reversão, então rode só em ambiente de desenvolvimento.
