import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { analyze, layerOf, moduleOf, readSourceTree, type SourceFiles } from '../support/architecture';

const ROOT = join(import.meta.dir, '..', '..');

describe('real src/ tree', () => {
  const files = readSourceTree(ROOT);
  const paths = Object.keys(files);

  test('the analysis sees the expected structure (guard against an empty test)', () => {
    expect(paths.length).toBeGreaterThan(25);
    for (const expected of [
      'src/shared/domain/money.ts',
      'src/app/wallet/domain/wallet.entity.ts',
      'src/app/wallet/domain/ledger-entry.entity.ts',
      'src/app/wagering/domain/wager-transaction.entity.ts',
      'src/app/wagering/domain/wager-processor.ts',
      'src/app/health/health.module.ts',
      'src/database/database.module.ts',
    ]) {
      expect(paths).toContain(expected);
    }
  });

  test('feature modules live in src/app; shared and database stay outside', () => {
    expect(paths.some((p) => p.startsWith('src/wallet/') || p.startsWith('src/wagering/') || p.startsWith('src/health/') || p.startsWith('src/messaging/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('src/app/shared/') || p.startsWith('src/app/database/'))).toBe(false);
  });

  test('the domain is pure: no Nest, MikroORM, AWS or infrastructure (only decimal.js, in Money)', () => {
    const domainFiles = paths.filter((p) => layerOf(p) === 'domain');
    expect(domainFiles.length).toBeGreaterThanOrEqual(8);
    expect(analyze(files).filter((v) => v.rule === 'domínio puro')).toEqual([]);
  });

  test('layers and dependencies between modules follow the rules', () => {
    expect(analyze(files).filter((v) => v.rule === 'camadas' || v.rule === 'módulos')).toEqual([]);
  });

  test('there are no cycles between files or between modules', () => {
    expect(analyze(files).filter((v) => v.rule.startsWith('ciclos'))).toEqual([]);
  });

  test('every relative import resolves to an existing file', () => {
    expect(analyze(files).filter((v) => v.rule === 'imports resolvidos')).toEqual([]);
  });

  test('no violation of any rule', () => {
    expect(analyze(files)).toEqual([]);
  });

  test('wallet never imports wagering (the direction is wagering → wallet)', () => {
    const offenders = paths.filter((p) => moduleOf(p) === 'wallet' && /app\/wagering|\.\.\/wagering/.test(files[p] ?? ''));
    expect(offenders).toEqual([]);
  });
});

describe('the checker detects violations (proof that the rules are not vacuous)', () => {
  const rules = (files: SourceFiles) => analyze(files).map((v) => v.rule);
  const base = { 'src/shared/domain/money.ts': "import Decimal from 'decimal.js';\nexport class Money {}" };

  test('a clean set produces no violations', () => {
    expect(analyze({
      ...base,
      'src/app/wallet/domain/wallet.entity.ts': "import { Money } from '../../../shared/domain/money';\nexport class Wallet {}",
      'src/app/wagering/domain/tx.entity.ts': "import { Wallet } from '../../wallet/domain/wallet.entity';\nexport class Tx {}",
    })).toEqual([]);
  });

  test('domain importing Nest, MikroORM or AWS', () => {
    for (const pkg of ['@nestjs/common', '@mikro-orm/core', '@aws-sdk/client-sqs', 'zod', 'node:crypto']) {
      expect(rules({ 'src/app/wallet/domain/w.entity.ts': `import { x } from '${pkg}';` })).toContain('domínio puro');
    }
  });

  test('decimal.js outside Money', () => {
    expect(rules({ 'src/app/wallet/domain/w.entity.ts': "import Decimal from 'decimal.js';" })).toContain('domínio puro');
    expect(rules({ 'src/shared/domain/other.ts': "import Decimal from 'decimal.js';" })).toContain('domínio puro');
  });

  test('multiline, type-only and export-from imports are also seen', () => {
    expect(rules({ 'src/app/wallet/domain/a.ts': "import {\n  A,\n  B,\n} from '@nestjs/common';" })).toContain('domínio puro');
    expect(rules({ 'src/app/wallet/domain/a.ts': "import type { A } from '@nestjs/common';" })).toContain('domínio puro');
    expect(rules({ 'src/app/wallet/domain/a.ts': "export { A } from '@nestjs/common';" })).toContain('domínio puro');
    expect(rules({ 'src/app/wallet/domain/a.ts': "import '@nestjs/common';" })).toContain('domínio puro');
  });

  test('domain importing application, infrastructure or presentation', () => {
    for (const layer of ['application', 'infrastructure', 'presentation']) {
      expect(rules({
        [`src/app/wallet/${layer}/x.ts`]: 'export const x = 1;',
        'src/app/wallet/domain/w.entity.ts': `import { x } from '../${layer}/x';`,
      })).toContain('camadas');
    }
  });

  test('domain importing shared/infrastructure or the database', () => {
    expect(rules({
      'src/shared/infrastructure/config.ts': 'export const c = 1;',
      'src/app/wallet/domain/w.entity.ts': "import { c } from '../../../shared/infrastructure/config';",
    })).toContain('camadas');
    expect(rules({
      'src/database/database.module.ts': 'export class D {}',
      'src/app/wallet/domain/w.entity.ts': "import { D } from '../../../database/database.module';",
    })).toContain('camadas');
  });

  test('application importing infrastructure or presentation; infrastructure importing presentation', () => {
    expect(rules({
      'src/app/wallet/infrastructure/r.ts': 'export const r = 1;',
      'src/app/wallet/application/u.ts': "import { r } from '../infrastructure/r';",
    })).toContain('camadas');
    expect(rules({
      'src/app/wallet/presentation/c.ts': 'export const c = 1;',
      'src/app/wallet/infrastructure/r.ts': "import { c } from '../presentation/c';",
    })).toContain('camadas');
  });

  test('application and presentation importing MikroORM or AWS; infrastructure may', () => {
    expect(rules({ 'src/app/wallet/application/u.ts': "import { EntityManager } from '@mikro-orm/core';" })).toContain('camadas');
    expect(rules({ 'src/app/wallet/presentation/c.ts': "import { SQSClient } from '@aws-sdk/client-sqs';" })).toContain('camadas');
    expect(rules({ 'src/app/wallet/infrastructure/r.ts': "import { EntityManager } from '@mikro-orm/core';" })).toEqual([]);
  });

  test('wallet importing wagering (forbidden direction) and an undeclared module', () => {
    expect(rules({
      'src/app/wagering/domain/t.entity.ts': 'export class T {}',
      'src/app/wallet/domain/w.entity.ts': "import { T } from '../../wagering/domain/t.entity';",
    })).toContain('módulos');
    expect(rules({
      'src/app/wallet/domain/w.entity.ts': 'export class W {}',
      'src/app/novo/domain/n.ts': "import { W } from '../../wallet/domain/w.entity';",
    })).toContain('módulos');
  });

  test('deep import into another module\'s infrastructure; *.module.ts is allowed', () => {
    expect(rules({
      'src/app/messaging/infrastructure/client.ts': 'export const c = 1;',
      'src/app/health/probe.ts': "import { c } from '../messaging/infrastructure/client';",
    })).toContain('módulos');
    expect(rules({
      'src/app/messaging/infrastructure/sqs.module.ts': 'export class SqsModule {}',
      'src/app/health/health.module.ts': "import { SqsModule } from '../messaging/infrastructure/sqs.module';",
    })).toEqual([]);
  });

  test('shared importing a feature module', () => {
    expect(rules({
      'src/app/wallet/domain/w.entity.ts': 'export class W {}',
      'src/shared/domain/x.ts': "import { W } from '../../app/wallet/domain/w.entity';",
    })).toContain('módulos');
  });

  test('cycle between files and between modules', () => {
    expect(rules({
      'src/app/wallet/domain/a.ts': "import { b } from './b';\nexport const a = 1;",
      'src/app/wallet/domain/b.ts': "import { a } from './a';\nexport const b = 1;",
    })).toContain('ciclos de arquivos');
    const moduleCycle = analyze({
      'src/app/wallet/domain/w.entity.ts': "import { T } from '../../wagering/domain/t.entity';",
      'src/app/wagering/domain/t.entity.ts': "import { W } from '../../wallet/domain/w.entity';",
    });
    expect(moduleCycle.map((v) => v.rule)).toContain('ciclos de módulos');
    expect(moduleCycle.map((v) => v.rule)).toContain('ciclos de arquivos');
  });

  test('relative import that does not resolve', () => {
    expect(rules({ 'src/app/wallet/domain/a.ts': "import { x } from './nao-existe';" })).toContain('imports resolvidos');
  });

  test('the composition root can import any module', () => {
    expect(rules({
      'src/app/health/health.module.ts': 'export class H {}',
      'src/api.module.ts': "import { H } from './app/health/health.module';",
    })).toEqual([]);
  });
});
