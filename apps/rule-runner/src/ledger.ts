import { ensureBalanced, generateId, type LedgerEntry } from '@loyaltyledger/core';
import type { PoolClient } from 'pg';

export async function postLedgerEntries(
  client: PoolClient,
  tenantId: string,
  entries: LedgerEntry[],
): Promise<string[]> {
  const entryIds: string[] = [];
  for (const entry of entries) {
    if (entry.lines.length === 0) {
      continue;
    }

    ensureBalanced(entry);
    const entryId = generateId();
    entryIds.push(entryId);

    await client.query(
      `INSERT INTO ledger_journal (entry_id, tenant_id, program_id, receipt_id, memo)
       VALUES ($1, $2, $3, $4, $5)` ,
      [entryId, tenantId, entry.programId, entry.receiptId ?? null, entry.memo ?? null],
    );

    let lineNo = 1;
    for (const line of entry.lines) {
      const debit = line.debit.toString();
      const credit = line.credit.toString();
      await client.query(
        `INSERT INTO ledger_lines (entry_id, line_no, account_id, dr, cr, unit)
         VALUES ($1, $2, $3, $4, $5, $6)` ,
        [entryId, lineNo, line.accountId, debit, credit, line.unit],
      );
      lineNo += 1;
    }
  }
  return entryIds;
}
