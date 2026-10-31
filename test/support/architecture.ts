import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { posix } from 'node:path';

/** Caminhos relativos à raiz do repositório, com "/" (ex.: "src/app/wallet/domain/wallet.entity.ts"). */
export type SourceFiles = Readonly<Record<string, string>>;

export interface Violation {
  file: string;
  rule: string;
  detail: string;
}

type Layer = 'domain' | 'application' | 'infrastructure' | 'presentation';
const LAYERS: readonly Layer[] = ['domain', 'application', 'infrastructure', 'presentation'];

/** Quais camadas cada camada pode importar (dentro do módulo, de outros módulos e do shared). */
const ALLOWED_LAYER_IMPORTS: Readonly<Record<Layer, readonly Layer[]>> = {
  domain: ['domain'],
  application: ['domain', 'application'],
  infrastructure: ['domain', 'application', 'infrastructure'],
  presentation: ['domain', 'application', 'presentation'],
};

/**
 * Direção permitida entre módulos (PDF, seção 7.1). Ao criar um módulo novo, declare-o aqui:
 * a omissão é intencional, para que toda dependência nova seja uma decisão explícita.
 * `root` (main.*, api.module, worker.module) é raiz de composição e pode importar tudo.
 */
export const ALLOWED_MODULE_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  shared: [],
  database: ['shared'],
  messaging: ['shared', 'database'],
  wallet: ['shared', 'database', 'messaging'],
  wagering: ['shared', 'database', 'messaging', 'wallet'],
  health: ['shared', 'database', 'messaging'],
};

/** Pacotes externos aceitos no domínio. O decimal.js só entra no Value Object Money. */
const DOMAIN_EXTERNALS = new Set(['decimal.js']);
const DECIMAL_OWNER = 'src/shared/domain/money.ts';
/** Preocupações de infraestrutura que nunca aparecem em application nem presentation. */
const INFRA_PACKAGES = [/^@mikro-orm\//, /^@aws-sdk\//];

const IMPORT_PATTERN = /\b(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g;

export function moduleOf(file: string): string {
  if (file.startsWith('src/app/')) return file.split('/')[2] ?? 'root';
  if (file.startsWith('src/shared/')) return 'shared';
  if (file.startsWith('src/database/')) return 'database';
  return 'root';
}

export function layerOf(file: string): Layer | undefined {
  const parts = file.split('/');
  const segment = file.startsWith('src/app/') ? parts[3] : file.startsWith('src/shared/') ? parts[2] : undefined;
  return LAYERS.find((layer) => layer === segment);
}

interface ImportEdge {
  from: string;
  spec: string;
  /** Arquivo de destino quando o import é relativo e resolvido. */
  target?: string;
}

function parseImports(file: string, content: string, files: SourceFiles): ImportEdge[] {
  const edges: ImportEdge[] = [];
  for (const match of content.matchAll(IMPORT_PATTERN)) {
    const spec = match[1] ?? match[2];
    if (!spec) continue;
    if (!spec.startsWith('.')) {
      edges.push({ from: file, spec });
      continue;
    }
    const base = posix.join(posix.dirname(file), spec);
    const target = [base, `${base}.ts`, `${base}/index.ts`].find((candidate) => candidate in files);
    edges.push({ from: file, spec, target });
  }
  return edges;
}

export function analyze(files: SourceFiles): Violation[] {
  const violations: Violation[] = [];
  const add = (file: string, rule: string, detail: string) => violations.push({ file, rule, detail });
  const edges = Object.entries(files).flatMap(([file, content]) => parseImports(file, content, files));

  for (const edge of edges) {
    const { from, spec, target } = edge;
    const fromLayer = layerOf(from);
    const fromModule = moduleOf(from);

    if (!target && spec.startsWith('.')) {
      add(from, 'imports resolvidos', `não foi possível resolver "${spec}"`);
      continue;
    }

    // --- pacotes externos
    if (!target) {
      if (fromLayer === 'domain') {
        if (!DOMAIN_EXTERNALS.has(spec)) {
          add(from, 'domínio puro', `o domínio não pode importar "${spec}"`);
        } else if (from !== DECIMAL_OWNER) {
          add(from, 'domínio puro', `"${spec}" só é permitido em ${DECIMAL_OWNER}`);
        }
      }
      if ((fromLayer === 'application' || fromLayer === 'presentation') && INFRA_PACKAGES.some((p) => p.test(spec))) {
        add(from, 'camadas', `${fromLayer} não pode importar o pacote de infraestrutura "${spec}"`);
      }
      continue;
    }

    const targetLayer = layerOf(target);
    const targetModule = moduleOf(target);

    // --- camadas (valem dentro do módulo, entre módulos e para o shared)
    if (fromLayer && fromLayer !== 'infrastructure' && targetModule === 'database') {
      add(from, 'camadas', `${fromLayer} não pode importar o database (${spec})`);
    }
    if (fromLayer && targetLayer && !ALLOWED_LAYER_IMPORTS[fromLayer].includes(targetLayer)) {
      add(from, 'camadas', `${fromLayer} não pode importar ${targetLayer} (${spec})`);
    }

    // --- dependências entre módulos
    if (fromModule !== targetModule && fromModule !== 'root') {
      const allowed = ALLOWED_MODULE_DEPENDENCIES[fromModule];
      if (!allowed) {
        add(from, 'módulos', `o módulo "${fromModule}" não está declarado em ALLOWED_MODULE_DEPENDENCIES`);
      } else if (!allowed.includes(targetModule)) {
        add(from, 'módulos', `"${fromModule}" não pode depender de "${targetModule}" (${spec})`);
      }
      // Entre módulos de funcionalidade só se importa a superfície pública: domain, application ou um *.module.ts.
      const isFeatureTarget = target.startsWith('src/app/');
      if (isFeatureTarget && targetLayer !== 'domain' && targetLayer !== 'application' && !target.endsWith('.module.ts')) {
        add(from, 'módulos', `import profundo em "${targetModule}": só domain, application ou *.module.ts (${spec})`);
      }
    }
  }

  violations.push(...findCycles(files, edges));
  return violations;
}

function findCycles(files: SourceFiles, edges: ImportEdge[]): Violation[] {
  const violations: Violation[] = [];

  const fileGraph = new Map<string, Set<string>>();
  const moduleGraph = new Map<string, Set<string>>();
  for (const file of Object.keys(files)) fileGraph.set(file, new Set());
  for (const edge of edges) {
    if (!edge.target) continue;
    fileGraph.get(edge.from)?.add(edge.target);
    const [a, b] = [moduleOf(edge.from), moduleOf(edge.target)];
    if (a !== b && a !== 'root') {
      if (!moduleGraph.has(a)) moduleGraph.set(a, new Set());
      moduleGraph.get(a)?.add(b);
    }
  }

  const report = (graph: Map<string, Set<string>>, label: string) => {
    const state = new Map<string, 'visiting' | 'done'>();
    const stack: string[] = [];
    const visit = (node: string) => {
      if (state.get(node) === 'done') return;
      if (state.get(node) === 'visiting') {
        const cycle = [...stack.slice(stack.indexOf(node)), node];
        violations.push({ file: node, rule: `ciclos de ${label}`, detail: cycle.join(' -> ') });
        return;
      }
      state.set(node, 'visiting');
      stack.push(node);
      for (const next of graph.get(node) ?? []) visit(next);
      stack.pop();
      state.set(node, 'done');
    };
    for (const node of graph.keys()) visit(node);
  };

  report(fileGraph, 'arquivos');
  report(moduleGraph, 'módulos');
  return violations;
}

/** Lê todos os .ts de src/ para analisar a árvore real. */
export function readSourceTree(root: string): SourceFiles {
  const files: Record<string, string> = {};
  for (const relative of readdirSync(join(root, 'src'), { recursive: true }) as string[]) {
    if (!relative.endsWith('.ts')) continue;
    const key = `src/${relative.replaceAll('\\', '/')}`;
    files[key] = readFileSync(join(root, key), 'utf8');
  }
  return files;
}
