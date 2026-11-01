interface PooledClient {
  once(event: 'end', listener: () => void): unknown;
  release?(error?: Error): void;
}

interface ClientPool {
  on(event: 'connect', listener: (client: PooledClient) => void): unknown;
}

/**
 * O Kysely 0.29 só devolve a conexão de uma transação ao pool depois que o COMMIT ou o ROLLBACK dão certo.
 * Com a conexão morta os dois falham, e a vaga do pool se perde para sempre: bastam tantas quedas quanto
 * o tamanho do pool para a instância responder 503 até reiniciar, e o encerramento dela nunca termina.
 *
 * Aqui, a conexão que termina enquanto está emprestada volta ao pool como quebrada, e ele a descarta.
 * Se já tiver sido devolvida, `release` lança, e não há nada a fazer.
 */
export function releaseDroppedConnections(pool: ClientPool): void {
  pool.on('connect', (client) => {
    client.once('end', () => {
      try {
        client.release?.(new Error('conexão com o PostgreSQL encerrada'));
      } catch {
        // Já devolvida ao pool.
      }
    });
  });
}
