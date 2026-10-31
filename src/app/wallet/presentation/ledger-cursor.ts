const MAX_SEQ = 9223372036854775807n;

/** Cursor opaco: esconde o `seq` do cliente, que só deve devolvê-lo como recebeu. */
export function encodeLedgerCursor(seq: string): string {
  return Buffer.from(seq, 'utf8').toString('base64url');
}

/** `undefined` se o cursor não foi produzido por encodeLedgerCursor. */
export function decodeLedgerCursor(cursor: string): string | undefined {
  const seq = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^[1-9]\d{0,18}$/.test(seq) || BigInt(seq) > MAX_SEQ) return undefined;
  return encodeLedgerCursor(seq) === cursor ? seq : undefined;
}
