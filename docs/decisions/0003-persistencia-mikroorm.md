# 0003 — Persistência com MikroORM

Status: implementada · Data: 31/10/2026.
Consolidada na seção 5 ("PostgreSQL e MikroORM") do `ARCHITECTURE.md` (README, seção 4: ORM, `Money` e estratégia
transacional precisam ser justificados).

## Domínio separado do ORM

`Wallet`, `WagerTransaction` e `WalletLedgerEntry` têm construtor privado e nenhum decorator. Cada tabela tem
uma linha plana (`*.schema.ts`, `EntitySchema`) e um mapper. O mapper lê com `rehydrate`, sem transições.

## Sem Unit of Work do ORM nas escritas

Os repositórios leem com `disableIdentityMap` e escrevem com comandos diretos (`insert`, `nativeUpdate`):

- **Saldo nunca velho:** toda leitura vai ao banco; o Identity Map não pode devolver um saldo anterior ao lock.
- **Ordem explícita:** a ordem do SQL é a das chamadas. Isso importa porque o trigger do ledger exige a
  transação gravada antes do lançamento.

O custo é abrir mão do change tracking, irrelevante aqui, onde cada operação grava poucas linhas conhecidas.

## Transações

`UnitOfWork.run` usa `orm.em.fork().transactional(...)`: um `EntityManager` por execução, em uma transação
READ COMMITTED, com `SET LOCAL lock_timeout`. Os repositórios são criados para aquele `EntityManager`, então
todos escrevem na mesma transação. Lançar dentro de `work` desfaz tudo.

`src/persistence.module.ts` é a raiz de composição e o único lugar que conhece as implementações. Os casos de
uso dependem do token `UNIT_OF_WORK` e dos ports; nenhum módulo importa a infraestrutura de outro.

## Lock

`findByIdForUpdate` emite `SELECT ... FOR UPDATE` na linha da wallet e devolve o saldo efetivado. O lock é por
linha, então wallets diferentes não se bloqueiam. `update(wallet, expectedVersion)` é uma rede adicional: só
grava se a versão for a esperada.

## Money

`NUMERIC(20,2)` trafega como string nos dois sentidos, sem passar por `number`. `moneyFromColumn` aceita sinal
porque `Money.from` só aceita entrada externa não negativa, e o total assinado do ledger pode ser negativo.

## Erros

`translatePersistenceError` só traduz o que o caso de uso sabe tratar, sem SQL nem valores na mensagem (o
original fica em `cause`, que não deve ir a logs sem filtro):

| Origem | Resultado |
|---|---|
| SQLSTATE classe 23 (constraint, trigger) | `PersistenceConstraintError`, com o nome da constraint |
| Lock timeout, deadlock, serialização, conexão, servidor reiniciando | `TransientInfrastructureError` |
| Domínio, defeitos, SQL inválido | Seguem sem tradução |

## Mudanças no que já existia

- **Migration 8, `observed_balance_currency`:** o saldo observado é da wallet, e em `CURRENCY_MISMATCH` a moeda
  difere da operação. Sem a coluna, o replay devolveria o saldo na moeda errada. As anteriores não foram
  editadas, e a migration preenche as linhas existentes.
- **`WagerTransaction.scheduleReferenceRetry`, `attempts`, `nextAttemptAt`:** o banco exige agendamento em
  `PENDING_REFERENCE`. O prazo é decidido por quem chama; o backoff entra com o retrier.
- **`DatabaseModule.forRoot(schemas)`:** agora global, recebe a lista explícita de schemas.

## Inbox e outbox

Só a persistência de que o consumer e o publisher precisariam (implementados depois; ver 0007 e 0008), com registros planos. As entidades `InboxMessage`,
`OutboxMessage` e `IntegrationEvent` entram com o consumer e o publisher.

## O que ainda dependia do caso de uso principal (ver 0004)

Lock, replay, idempotência e atomicidade existem como peças testadas, mas nenhum fluxo de produção as usava na época; `ProcessWagerTransaction` (0004) passou a usá-las.
