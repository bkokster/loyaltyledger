export function ensureBalanced(entry) {
    const totalDebit = entry.lines.reduce((acc, line) => acc + line.debit, 0n);
    const totalCredit = entry.lines.reduce((acc, line) => acc + line.credit, 0n);
    if (totalDebit !== totalCredit) {
        throw new Error(`Ledger entry is not balanced: debit=${totalDebit} credit=${totalCredit}`);
    }
}
