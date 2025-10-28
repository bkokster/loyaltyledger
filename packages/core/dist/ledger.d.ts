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
export declare function ensureBalanced(entry: LedgerEntry): void;
