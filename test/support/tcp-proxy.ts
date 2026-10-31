import net from 'node:net';

export interface TcpProxy {
  readonly port: number;
  /** Para de escutar e derruba as conexões abertas: simula o serviço caindo. */
  close(): Promise<void>;
  /** Volta a escutar na MESMA porta: simula a recuperação. */
  open(): Promise<void>;
}

/** Proxy TCP real e transparente. Permite derrubar e recuperar o PostgreSQL sem tocar no Docker. */
export async function startTcpProxy(target: { host: string; port: number }): Promise<TcpProxy> {
  const sockets = new Set<net.Socket>();
  let server: net.Server | undefined;
  let port = 0;

  const open = () =>
    new Promise<void>((resolve, reject) => {
      server = net.createServer((client) => {
        const upstream = net.connect(target.port, target.host);
        sockets.add(client);
        sockets.add(upstream);
        const drop = () => {
          client.destroy();
          upstream.destroy();
          sockets.delete(client);
          sockets.delete(upstream);
        };
        client.on('error', drop).on('close', drop);
        upstream.on('error', drop).on('close', drop);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        port = (server!.address() as net.AddressInfo).port;
        resolve();
      });
    });

  const close = () =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      sockets.clear();
      if (!server) return resolve();
      server.close(() => resolve());
      server = undefined;
    });

  await open();
  return { get port() { return port; }, close, open };
}

/** Aceita conexões TCP e nunca responde: simula um serviço pendurado (o pior caso para timeouts). */
export async function startBlackhole(): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on('error', () => {}).on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
