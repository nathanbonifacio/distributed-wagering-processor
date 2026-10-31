/**
 * JSON com as chaves de objetos ordenadas recursivamente (por unidade de código UTF-16, como `sort`).
 * Campos `undefined` não entram, então um campo ausente e um `undefined` produzem o mesmo texto.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) sorted[key] = sortKeys(source[key]);
  return sorted;
}
