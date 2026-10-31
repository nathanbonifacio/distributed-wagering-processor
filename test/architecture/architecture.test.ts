import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { analyze, layerOf, moduleOf, readSourceTree, type SourceFiles } from '../support/architecture';

const ROOT = join(import.meta.dir, '..', '..');

describe('árvore real de src/', () => {
  const files = readSourceTree(ROOT);
  const paths = Object.keys(files);

  test('a análise enxerga a estrutura esperada (guarda contra teste vazio)', () => {
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

  test('módulos de funcionalidade vivem em src/app; shared e database ficam fora', () => {
    expect(paths.some((p) => p.startsWith('src/wallet/') || p.startsWith('src/wagering/') || p.startsWith('src/health/') || p.startsWith('src/messaging/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('src/app/shared/') || p.startsWith('src/app/database/'))).toBe(false);
  });

  test('o domínio é puro: nada de Nest, MikroORM, AWS nem infraestrutura (só decimal.js, em Money)', () => {
    const domainFiles = paths.filter((p) => layerOf(p) === 'domain');
    expect(domainFiles.length).toBeGreaterThanOrEqual(8);
    expect(analyze(files).filter((v) => v.rule === 'domínio puro')).toEqual([]);
  });

  test('camadas e dependências entre módulos respeitam as regras', () => {
    expect(analyze(files).filter((v) => v.rule === 'camadas' || v.rule === 'módulos')).toEqual([]);
  });

  test('não há ciclos entre arquivos nem entre módulos', () => {
    expect(analyze(files).filter((v) => v.rule.startsWith('ciclos'))).toEqual([]);
  });

  test('todos os imports relativos resolvem para um arquivo existente', () => {
    expect(analyze(files).filter((v) => v.rule === 'imports resolvidos')).toEqual([]);
  });

  test('nenhuma violação de qualquer regra', () => {
    expect(analyze(files)).toEqual([]);
  });

  test('wallet nunca importa wagering (a direção é wagering → wallet)', () => {
    const offenders = paths.filter((p) => moduleOf(p) === 'wallet' && /app\/wagering|\.\.\/wagering/.test(files[p] ?? ''));
    expect(offenders).toEqual([]);
  });
});

describe('o verificador detecta violações (prova de que as regras não são vacuosas)', () => {
  const rules = (files: SourceFiles) => analyze(files).map((v) => v.rule);
  const base = { 'src/shared/domain/money.ts': "import Decimal from 'decimal.js';\nexport class Money {}" };

  test('um conjunto limpo não gera violações', () => {
    expect(analyze({
      ...base,
      'src/app/wallet/domain/wallet.entity.ts': "import { Money } from '../../../shared/domain/money';\nexport class Wallet {}",
      'src/app/wagering/domain/tx.entity.ts': "import { Wallet } from '../../wallet/domain/wallet.entity';\nexport class Tx {}",
    })).toEqual([]);
  });

  test('domínio importando Nest, MikroORM ou AWS', () => {
    for (const pkg of ['@nestjs/common', '@mikro-orm/core', '@aws-sdk/client-sqs', 'zod', 'node:crypto']) {
      expect(rules({ 'src/app/wallet/domain/w.entity.ts': `import { x } from '${pkg}';` })).toContain('domínio puro');
    }
  });

  test('decimal.js fora de Money', () => {
    expect(rules({ 'src/app/wallet/domain/w.entity.ts': "import Decimal from 'decimal.js';" })).toContain('domínio puro');
    expect(rules({ 'src/shared/domain/other.ts': "import Decimal from 'decimal.js';" })).toContain('domínio puro');
  });

  test('imports multilinha, type-only e export-from também são vistos', () => {
    expect(rules({ 'src/app/wallet/domain/a.ts': "import {\n  A,\n  B,\n} from '@nestjs/common';" })).toContain('domínio puro');
    expect(rules({ 'src/app/wallet/domain/a.ts': "import type { A } from '@nestjs/common';" })).toContain('domínio puro');
    expect(rules({ 'src/app/wallet/domain/a.ts': "export { A } from '@nestjs/common';" })).toContain('domínio puro');
    expect(rules({ 'src/app/wallet/domain/a.ts': "import '@nestjs/common';" })).toContain('domínio puro');
  });

  test('domínio importando application, infrastructure ou presentation', () => {
    for (const layer of ['application', 'infrastructure', 'presentation']) {
      expect(rules({
        [`src/app/wallet/${layer}/x.ts`]: 'export const x = 1;',
        'src/app/wallet/domain/w.entity.ts': `import { x } from '../${layer}/x';`,
      })).toContain('camadas');
    }
  });

  test('domínio importando o shared/infrastructure ou o database', () => {
    expect(rules({
      'src/shared/infrastructure/config.ts': 'export const c = 1;',
      'src/app/wallet/domain/w.entity.ts': "import { c } from '../../../shared/infrastructure/config';",
    })).toContain('camadas');
    expect(rules({
      'src/database/database.module.ts': 'export class D {}',
      'src/app/wallet/domain/w.entity.ts': "import { D } from '../../../database/database.module';",
    })).toContain('camadas');
  });

  test('application importando infrastructure ou presentation; infrastructure importando presentation', () => {
    expect(rules({
      'src/app/wallet/infrastructure/r.ts': 'export const r = 1;',
      'src/app/wallet/application/u.ts': "import { r } from '../infrastructure/r';",
    })).toContain('camadas');
    expect(rules({
      'src/app/wallet/presentation/c.ts': 'export const c = 1;',
      'src/app/wallet/infrastructure/r.ts': "import { c } from '../presentation/c';",
    })).toContain('camadas');
  });

  test('application e presentation importando MikroORM ou AWS; infrastructure pode', () => {
    expect(rules({ 'src/app/wallet/application/u.ts': "import { EntityManager } from '@mikro-orm/core';" })).toContain('camadas');
    expect(rules({ 'src/app/wallet/presentation/c.ts': "import { SQSClient } from '@aws-sdk/client-sqs';" })).toContain('camadas');
    expect(rules({ 'src/app/wallet/infrastructure/r.ts': "import { EntityManager } from '@mikro-orm/core';" })).toEqual([]);
  });

  test('wallet importando wagering (direção proibida) e módulo não declarado', () => {
    expect(rules({
      'src/app/wagering/domain/t.entity.ts': 'export class T {}',
      'src/app/wallet/domain/w.entity.ts': "import { T } from '../../wagering/domain/t.entity';",
    })).toContain('módulos');
    expect(rules({
      'src/app/wallet/domain/w.entity.ts': 'export class W {}',
      'src/app/novo/domain/n.ts': "import { W } from '../../wallet/domain/w.entity';",
    })).toContain('módulos');
  });

  test('import profundo na infraestrutura de outro módulo; *.module.ts é permitido', () => {
    expect(rules({
      'src/app/messaging/infrastructure/client.ts': 'export const c = 1;',
      'src/app/health/probe.ts': "import { c } from '../messaging/infrastructure/client';",
    })).toContain('módulos');
    expect(rules({
      'src/app/messaging/infrastructure/sqs.module.ts': 'export class SqsModule {}',
      'src/app/health/health.module.ts': "import { SqsModule } from '../messaging/infrastructure/sqs.module';",
    })).toEqual([]);
  });

  test('shared importando um módulo de funcionalidade', () => {
    expect(rules({
      'src/app/wallet/domain/w.entity.ts': 'export class W {}',
      'src/shared/domain/x.ts': "import { W } from '../../app/wallet/domain/w.entity';",
    })).toContain('módulos');
  });

  test('ciclo entre arquivos e entre módulos', () => {
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

  test('import relativo que não resolve', () => {
    expect(rules({ 'src/app/wallet/domain/a.ts': "import { x } from './nao-existe';" })).toContain('imports resolvidos');
  });

  test('a raiz de composição pode importar qualquer módulo', () => {
    expect(rules({
      'src/app/health/health.module.ts': 'export class H {}',
      'src/api.module.ts': "import { H } from './app/health/health.module';",
    })).toEqual([]);
  });
});
