export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timeout após ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Executa `work` com um prazo. O AbortSignal permite cancelar o IO que o suporta (SDK da AWS);
 * para IO sem suporte a signal, o Promise.race ainda garante que quem espera é liberado no prazo.
 * O trabalho sem suporte a signal continua pendente: por isso os drivers também têm timeouts próprios.
 */
export async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(ms));
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
