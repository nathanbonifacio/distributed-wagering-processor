# 0001 — Organização modular do código

Status: aprovada e implementada · Data: 31/10/2026 · Origem: revisão da estrutura, feita quando o domínio financeiro ficou pronto.
Consolidada na seção 2 ("Organização do código") do `ARCHITECTURE.md`. O "PDF de arquitetura" citado abaixo é o planejamento inicial do projeto e não faz parte do repositório.

## Contexto

O PDF de arquitetura (seção 12.1) previa `src/<módulo>/` com camadas internas. Com o domínio financeiro
pronto, a estrutura foi revisada para que os módulos fiquem fáceis de identificar e para que a fronteira
entre domínio e persistência seja visível na árvore, não só uma convenção.

## Decisão

Módulos de funcionalidade ficam em `src/app/<módulo>/`, com camadas internas criadas **apenas quando houver
arquivos** para elas. `shared/` e `database/` ficam fora de `app/`.

```
src/
  main.api.ts · main.worker.ts · api.module.ts · worker.module.ts   raízes de composição
  app/<módulo>/
    domain/                     entidades, serviço de domínio, erros, eventos (TypeScript puro)
    application/                use cases (*.use-case.ts) e ports
    infrastructure/persistence/ schemas do MikroORM (*.schema.ts), mappers, repositórios
    presentation/               controller e dto/ (schemas zod + tipos inferidos)
    <módulo>.module.ts
  shared/                       Money, DomainError, config, utilitários: núcleo, não é um módulo
  database/                     DatabaseModule, runner e migrations do banco único
test/                           unit/ · integration/ · architecture/ · concurrency/ · support/
```

Módulos técnicos pequenos (hoje `health`) permanecem planos, sem camadas.

### Convenções de nome

| Sufixo | Significado |
|---|---|
| `*.entity.ts` | entidade ou agregado de **domínio** (construtor privado, `rehydrate`) |
| `*.schema.ts` | mapeamento de **persistência** (MikroORM `EntitySchema`) |
| `*.use-case.ts` | serviço de aplicação que coordena um caso de uso |
| `*.service.ts` | reservado a injetáveis do Nest (ex.: `HealthService`) |
| `*.dto.ts` | contrato HTTP (schema zod) |
| `*.enum.ts` | enum, em `enums/` quando houver pelo menos 2 (regra mantida; na implementação final os enums ficam junto das entidades e nenhuma pasta `enums/` foi necessária) |

### Regras de dependência (verificadas em `test/architecture`)

1. **Domínio puro:** `domain/` não importa Nest, MikroORM, AWS nem outras camadas. O único pacote externo
   permitido é o `decimal.js`, e apenas em `shared/domain/money.ts`.
2. **Camadas:** `domain` → nada; `application` → `domain`; `infrastructure` → `domain`, `application`;
   `presentation` → `domain`, `application`. `application` e `presentation` não importam MikroORM nem AWS.
   Só `infrastructure` acessa `database/`.
3. **Módulos:** `shared` ← `database` ← `messaging` ← `wallet` ← `wagering`; `health` depende de `shared`,
   `database` e `messaging`. A tabela está em `ALLOWED_MODULE_DEPENDENCIES`: um módulo novo precisa ser
   declarado ali, o que torna cada dependência nova uma decisão explícita.
4. **Superfície pública:** entre módulos de funcionalidade só se importa `domain/`, `application/` ou um
   `*.module.ts`; nunca `infrastructure/` ou `presentation/` de outro módulo.
5. **Sem ciclos**, entre arquivos nem entre módulos.

## Alternativa descartada

`src/app/<módulo>/{dto, entities, enums, *.service.ts}` plano. Misturaria a entidade de domínio com o schema
do ORM em `entities/`, não teria lugar para mappers, repositórios e ports, e concentraria os use cases em um
único service por módulo (o PDF prevê vários só em `wallet`).

## Risco aberto: ciclo `wallet` ↔ `wagering` no `OpenWallet`

O fluxo A (`POST /wallets`) cria a wallet **e** a transação OPENING com seu lançamento. A `Wallet` e o
ledger pertencem a `wallet`; a `WagerTransaction` e o `WagerProcessor.processOpening` pertencem a
`wagering`. Como `wagering` já depende de `wallet`, colocar o `OpenWallet` em `wallet` criaria o ciclo
`wallet → wagering → wallet`. O teste de arquitetura reprova esse ciclo.

**Decisão: opção A**, por ser o único fluxo que cruza os agregados até então (ver 0005). A opção A foi mantida na implementação final. Opções avaliadas:

| Opção | Composição | Custo |
|---|---|---|
| A | `OpenWallet` e `POST /wallets` em `wagering` (já depende de `wallet`); `wallet` mantém consultas e reconciliação | Nenhum módulo novo; a rota fica em um módulo que não leva o nome do recurso (rotas HTTP não dependem disso) |
| B | Port `OpeningTransactionRecorder` em `wallet/application`, implementada por `wagering/infrastructure` e ligada na raiz de composição | `wallet` continua dono do caso de uso; exige ligação explícita na raiz para não criar ciclo de módulos do Nest |
| C | Módulo novo de orquestração (ex.: `wallet-opening`), dependendo de `wallet` e `wagering` | Mais um módulo; é a opção mais limpa se surgirem outros fluxos que cruzem os dois agregados |

Critério sugerido para decidir: se `OpenWallet` for o único fluxo que cruza os agregados, a opção A é a
mais simples; havendo mais de um, a opção C. Qualquer escolha exige declarar a dependência em
`ALLOWED_MODULE_DEPENDENCIES`.

## Outras consequências

- Os schemas do MikroORM devem ser registrados em **lista explícita**, nunca por busca em pastas, para não
  depender de TypeScript em tempo de execução nem da árvore de diretórios.
- Não há alias de caminho (`paths`); os imports continuam relativos.
- Esta organização difere da seção 12.1 do PDF de planejamento apenas pelo nível `app/`.
