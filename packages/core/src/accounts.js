export function merchantAccountId(tenantId) {
    return `${tenantId}::merchant_liability`;
}
export function customerAccountId(tenantId, accountRef) {
    return `${tenantId}::acct::${accountRef}`;
}
export function normaliseAccountId(tenantId, provided) {
    if (provided === 'merchant' || provided === 'merchant_liability') {
        return merchantAccountId(tenantId);
    }
    return customerAccountId(tenantId, provided);
}
