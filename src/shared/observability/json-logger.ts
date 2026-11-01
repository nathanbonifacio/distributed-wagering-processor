import type { LoggerService } from '@nestjs/common';
import pino from 'pino';
import { currentContext } from '../application/request-context';

/** Nunca devem aparecer em um log. Existem como rede de segurança: o código só loga identificadores. */
const REDACTED_KEYS = [
  'money',
  'amount',
  'balance',
  'balanceBefore',
  'balanceAfter',
  'storedBalance',
  'calculatedBalance',
  'payload',
  'body',
  'headers',
  'authorization',
  'password',
  'secret',
  'token',
  'accessKeyId',
  'secretAccessKey',
];

export interface LogSink {
  write(line: string): void;
}

type Level = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

/**
 * Logger do Nest que escreve uma linha JSON por registro. O contexto da requisição ou da mensagem
 * (correlationId, messageId, transactionId, walletId, providerId) entra sozinho; campos explícitos
 * passados como objeto prevalecem. Stack traces não saem: a mensagem de um erro pode trazer SQL ou valores.
 */
export class JsonLogger implements LoggerService {
  private readonly out: pino.Logger;

  constructor(sink: LogSink = process.stdout, level: Level = 'info') {
    this.out = pino(
      {
        level,
        base: undefined,
        messageKey: 'msg',
        timestamp: pino.stdTimeFunctions.isoTime,
        formatters: { level: (label) => ({ level: label }) },
        redact: { paths: REDACTED_KEYS.flatMap((key) => [key, `*.${key}`]), censor: '[redacted]' },
      },
      sink,
    );
  }

  log(message: unknown, ...rest: unknown[]): void {
    this.write('info', message, rest);
  }
  error(message: unknown, ...rest: unknown[]): void {
    this.write('error', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]): void {
    this.write('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]): void {
    this.write('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]): void {
    this.write('trace', message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]): void {
    this.write('fatal', message, rest);
  }

  private write(level: Level, message: unknown, rest: unknown[]): void {
    // O Nest acrescenta o nome da classe como último argumento de texto.
    const last = rest.at(-1);
    const source = typeof last === 'string' ? last : undefined;
    const fields =
      message !== null && typeof message === 'object' && !(message instanceof Error)
        ? { ...(message as Record<string, unknown>) }
        : { msg: message instanceof Error ? message.name : String(message) };
    const { msg, message: alias, ...explicit } = fields as Record<string, unknown>;
    this.out[level]({ ...(source ? { context: source } : {}), ...currentContext(), ...explicit }, String(msg ?? alias ?? ''));
  }
}
