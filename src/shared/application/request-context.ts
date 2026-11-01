import { AsyncLocalStorage } from 'node:async_hooks';

/** Identificadores que acompanham tudo o que acontece por causa de uma requisição, mensagem ou tentativa. */
export interface RequestContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Executa `work` com um contexto novo. Chamadas aninhadas herdam o contexto e podem enriquecê-lo. */
export function runWithContext<T>(context: RequestContext, work: () => T): T {
  return storage.run({ ...storage.getStore(), ...context }, work);
}

export function currentContext(): Readonly<RequestContext> {
  return storage.getStore() ?? {};
}

/** Acrescenta ids descobertos no meio do caminho (ex.: o transactionId). Sem contexto ativo, não faz nada. */
export function enrichContext(extra: RequestContext): void {
  const store = storage.getStore();
  if (store) Object.assign(store, extra);
}
