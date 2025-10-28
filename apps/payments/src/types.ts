export interface PaymentAccount {
  tenantId: string;
  merchantId: string;
  psp: string;
  pspAccountId: string;
  currency: string;
  payoutSchedule: string;
  status: 'active' | 'disabled' | 'kyc_pending';
  createdAt: Date;
  updatedAt: Date;
}

export interface PayoutBatch {
  batchId: string;
  tenantId: string;
  periodStart: Date;
  periodEnd: Date;
  currency: string;
  status: 'open' | 'submitting' | 'submitted' | 'reconciled' | 'failed';
  summary: Record<string, unknown> | null;
  createdAt: Date;
}

export type PayoutDirection = 'payout' | 'collect';

export interface PayoutItem {
  itemId: string;
  batchId: string;
  tenantId: string;
  merchantAccount: string;
  merchantId: string | null;
  pointsSettled: bigint;
  rateCentsPerPoint: number;
  grossCents: bigint;
  platformFeeBps: number;
  feeCents: bigint;
  settlementAdjBps: number | null;
  adjCents: bigint;
  netCents: bigint;
  direction: PayoutDirection;
  psp: string;
  pspTransferId: string | null;
  status: 'pending' | 'submitted' | 'succeeded' | 'failed' | 'reversed';
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Collection {
  collectionId: string;
  tenantId: string;
  merchantId: string;
  amountCents: bigint;
  currency: string;
  psp: string;
  pspDebitId: string | null;
  attempts: number;
  status: 'pending' | 'submitted' | 'succeeded' | 'failed';
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaymentEvent {
  eventId: string;
  tenantId: string;
  psp: string;
  pspEventType: string;
  pspObjectId: string;
  payload: unknown;
  receivedAt: Date;
}

export interface AmountComponents {
  grossCents: bigint;
  feeCents: bigint;
  adjustmentCents: bigint;
  netCents: bigint;
}

export interface FreezePolicyConfig {
  maxFailedAttempts: number;
  arrearsDays: number;
  minOutstandingCents: number;
}
