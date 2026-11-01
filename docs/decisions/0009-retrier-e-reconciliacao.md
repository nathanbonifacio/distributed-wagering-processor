# 0009 — Retrier de referências pendentes e reconciliação

Status: implementadas · Data: 01/11/2026.
Consolidada nas seções 12 e 14 do `ARCHITECTURE.md`.

## Retrier de PENDING_REFERENCE

- Reaproveita `ProcessWagerTransaction` (`resumePending`): as regras financeiras existem em um único lugar.
- Cada tentativa é uma transação SQL própria, com a mesma ordem de lock do fluxo normal: wallet, depois a linha
  da transação. Sob os dois locks a decisão é única, então vários retriers sobre a mesma linha nunca duplicam
  o efeito: quem chega depois encontra a linha já decidida ou reagendada.
- A consulta das vencidas não trava nada. Duas instâncias podem escolher a mesma linha, e o lock da wallet
  serializa o resto. Uma falha não conta como tentativa e não impede o resto do lote.
- Backoff `min(5s · 2^n, 5min)`, com `n` igual às tentativas já feitas, e 10 tentativas (cerca de 25 minutos).
  O README pede limite ou TTL e deixa o valor à escolha. Os três parâmetros são configuráveis por ambiente.
- Esgotado o limite, a transação vira `REJECTED`: `REFERENCE_NOT_FOUND` se a referência nunca apareceu, e
  `REFERENCE_NOT_PROCESSED` se ela existe, mas ficou pendente em uma cadeia de reversões. O evento
  `WagerTransactionRejected` sai na mesma transação.
- Enquanto a referência não existe, não há lançamento, não há mudança de saldo e não há novo evento: o
  `WagerTransactionPendingReference` marca só a entrada em pendência.
- Erro permanente durante a retomada grava `FAILED(INTERNAL_ERROR)` em transação separada. Erro transitório
  desfaz tudo e a linha continua vencida para a próxima rodada.
- Limitação conhecida: depois que a referência chega, a reversão só é liquidada na próxima tentativa agendada
  (no máximo 5 minutos com os valores padrão), e não no mesmo instante.

## Reconciliação

- Uma única instrução SQL lê o saldo guardado e a soma assinada do ledger, então ambos vêm do mesmo
  instantâneo, mesmo com débitos e créditos confirmando em paralelo. Não usa lock e não bloqueia escritas.
- Só lê. A divergência é devolvida como `consistent: false` e registrada em log e métrica, nunca corrigida.
- Lançamento em moeda diferente da wallet nunca entra na soma e é sempre uma divergência, mesmo com diferença
  zero. O schema atual não amarra a moeda do lançamento à da wallet (só o domínio garante isso). Uma constraint
  composta resolveria no banco; fica como melhoria registrada.
- Responde 200 com ou sem divergência: o recurso foi conferido com sucesso, e o resultado está no corpo.
