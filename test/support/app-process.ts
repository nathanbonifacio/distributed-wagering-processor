import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { testEnv } from './env';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export interface AppProcess {
  readonly role: 'api' | 'worker';
  readonly pid: number;
  readonly url: string;
  /** Structured log lines the process wrote to stdout, parsed. */
  readonly logs: Array<Record<string, any>>;
  readonly exited: Promise<number | null>;
  isRunning(): boolean;
  /** Sends the signal and waits for the process to be gone. */
  kill(signal: 'SIGKILL' | 'SIGTERM'): Promise<number | null>;
  /** Sends the signal and returns at once, to observe what the process does while shutting down. */
  signal(signal: 'SIGKILL' | 'SIGTERM'): void;
  metrics(): Promise<string>;
  /** Value of one metric sample, or 0 if it was never emitted. */
  sample(selector: string): Promise<number>;
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * Starts the real `main.api.ts` or `main.worker.ts` as an independent OS process: its own pool, its own memory,
 * nothing shared with the test but PostgreSQL and SQS. Resolves when `/health/live` answers.
 */
export async function startAppProcess(role: 'api' | 'worker', env: Record<string, string>): Promise<AppProcess> {
  const port = await freePort();
  const entry = role === 'api' ? 'src/main.api.ts' : 'src/main.worker.ts';
  const proc = Bun.spawn(['bun', 'run', entry], {
    cwd: ROOT,
    env: { ...process.env, ...testEnv(), ...env, ...(role === 'api' ? { PORT: String(port) } : { WORKER_PORT: String(port) }) },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const logs: Array<Record<string, any>> = [];
  const errors: string[] = [];
  const pump = async (stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) => {
    const decoder = new TextDecoder();
    let pending = '';
    for await (const chunk of stream) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      lines.filter(Boolean).forEach(onLine);
    }
  };
  void pump(proc.stdout, (line) => {
    try {
      logs.push(JSON.parse(line));
    } catch {
      errors.push(line);
    }
  });
  void pump(proc.stderr, (line) => errors.push(line));

  let running = true;
  const exited = proc.exited.then((code) => {
    running = false;
    return code;
  });
  const url = `http://127.0.0.1:${port}`;

  const deadline = Date.now() + 45_000;
  for (;;) {
    if (!running) throw new Error(`${role} exited during startup: ${errors.slice(-5).join(' | ')}`);
    try {
      if ((await fetch(`${url}/health/live`, { signal: AbortSignal.timeout(1000) })).ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error(`${role} did not become live in time: ${errors.slice(-5).join(' | ')}`);
    }
    await Bun.sleep(50);
  }

  const metrics = async () => (await fetch(`${url}/metrics`)).text();
  return {
    role,
    pid: proc.pid,
    url,
    logs,
    exited,
    isRunning: () => running,
    async kill(signal) {
      if (running) proc.kill(signal);
      return exited;
    },
    signal(signal) {
      if (running) proc.kill(signal);
    },
    metrics,
    async sample(selector) {
      const line = (await metrics()).split('\n').find((candidate) => candidate.startsWith(`${selector} `));
      return line ? Number(line.slice(selector.length + 1)) : 0;
    },
  };
}
