import type { Clock } from '../application/clock.port';
import type { IdGenerator } from '../application/id-generator.port';

export const systemClock: Clock = { now: () => new Date() };

/** UUIDv7: ordenado pelo tempo, o que mantém os índices das chaves primárias compactos. */
export const uuidV7Generator: IdGenerator = { next: () => Bun.randomUUIDv7() };
