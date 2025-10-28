export interface ReceiptLineItem {
    line_id: string;
    sku?: string;
    category?: string;
    qty: number;
    unit_price: number;
    attrs?: Record<string, unknown>;
}
export interface ReceiptTotals {
    subtotal?: number;
    discounts?: number;
    tax?: number;
    grand_total: number;
}
export interface ReceiptMerchant {
    merchant_id: string;
    store_id?: string;
    name?: string;
}
export interface ReceiptBuyer {
    account_ref: string;
    consent_scopes?: string[];
}
export interface ReceiptPayment {
    processor?: string;
    processor_txn_id?: string;
    method?: string;
}
export interface ReceiptSignature {
    alg?: string;
    kid?: string;
    jws?: string;
}
export interface ReceiptMeta {
    [key: string]: unknown;
}
export interface Receipt {
    schema_version: string;
    idempotency_key: string;
    issued_at: string;
    currency: string;
    merchant: ReceiptMerchant;
    buyer: ReceiptBuyer;
    payment?: ReceiptPayment;
    totals: ReceiptTotals;
    line_items: ReceiptLineItem[];
    signature?: ReceiptSignature;
    meta?: ReceiptMeta;
}
export interface ReceiptContext {
    tenantId: string;
    receipt: Receipt;
    receiptId: string;
}
export interface RedeemRequest {
    account_id: string;
    program_id: string;
    unit: string;
    qty: number;
    memo?: string;
    idempotency_key?: string;
    partner_hint?: string;
    burn_merchant_id?: string;
}
export interface RedeemContext {
    tenantId: string;
    requestId: string;
    redeem: RedeemRequest;
}
