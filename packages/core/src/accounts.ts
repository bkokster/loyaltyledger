export function merchantAccountId(tenantId: string): string {
  return `${tenantId}::merchant_liability`;
}

export function customerAccountId(tenantId: string, accountRef: string): string {
  return `${tenantId}::acct::${accountRef}`;
}

export function normaliseAccountId(tenantId: string, provided: string): string {
  if (provided === 'merchant' || provided === 'merchant_liability') {
    return merchantAccountId(tenantId);
  }

  return customerAccountId(tenantId, provided);
}
