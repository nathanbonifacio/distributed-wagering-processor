import net from 'node:net';

export type SqsAction = 'DeleteMessage' | 'SendMessage' | 'ReceiveMessage';

export interface SqsGate {
  readonly port: number;
  /**
   * Arms the gate: the next request for `action` is swallowed (never forwarded to SQS) and its connection stays
   * silent. The promise resolves the moment that request arrives, which is the exact instant the test wants:
   * for DeleteMessage, after the worker committed and before it acknowledged.
   */
  holdNext(action: SqsAction): Promise<void>;
  /** Requests seen per action, forwarded or held. */
  seen(action: SqsAction): number;
  close(): Promise<void>;
}

/** The AWS JSON protocol puts the action in a header, the query protocol in the body: both are recognised. */
function actionOf(chunk: string): SqsAction | undefined {
  for (const action of ['DeleteMessage', 'SendMessage', 'ReceiveMessage'] as const) {
    const json = new RegExp(`AmazonSQS\\.${action}(?!Batch)`);
    const query = new RegExp(`Action=${action}(?!Batch)(?:&|$)`);
    if (json.test(chunk) || query.test(chunk)) return action;
  }
  return undefined;
}

/** A transparent TCP proxy to SQS that can freeze one request on demand. Used to kill real processes at an exact point. */
export async function startSqsGate(target: { host: string; port: number }): Promise<SqsGate> {
  const sockets = new Set<net.Socket>();
  const counts = new Map<SqsAction, number>();
  let armed: { action: SqsAction; held: () => void } | undefined;

  const server = net.createServer((client) => {
    const upstream = net.connect(target.port, target.host);
    sockets.add(client);
    sockets.add(upstream);
    let swallowing = false;
    const drop = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on('error', drop).on('close', drop);
    upstream.on('error', drop).on('close', drop);

    client.on('data', (chunk) => {
      if (swallowing) return;
      const action = actionOf(chunk.toString('latin1'));
      if (action) counts.set(action, (counts.get(action) ?? 0) + 1);
      if (action && armed?.action === action) {
        // The rest of this request (headers and body can arrive in separate chunks) is swallowed too.
        swallowing = true;
        const { held } = armed;
        armed = undefined;
        held();
        return;
      }
      upstream.write(chunk);
    });
    upstream.pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;

  return {
    port,
    holdNext: (action) =>
      new Promise<void>((resolve) => {
        armed = { action, held: resolve };
      }),
    seen: (action) => counts.get(action) ?? 0,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
