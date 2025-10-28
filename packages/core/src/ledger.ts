export interface LedgerLine {
  accountId: string;
  debit: bigint;
  credit: bigint;
  unit: string;
}

export interface LedgerEntry {
  programId: string;
  memo?: string;
  receiptId?: string;
  lines: LedgerLine[];
}

export interface LedgerMutation {
  entries: LedgerEntry[];
  summary?: Record<string, unknown>;
}

export function ensureBalanced(entry: LedgerEntry): void {
  const totalDebit = entry.lines.reduce((acc, line) => acc + line.debit, 0n);
  const totalCredit = entry.lines.reduce((acc, line) => acc + line.credit, 0n);

  if (totalDebit !== totalCredit) {
    throw new Error(`Ledger entry is not balanced: debit=${totalDebit} credit=${totalCredit}`);
  }
}
