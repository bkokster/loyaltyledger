import type { ReceiptPlugin, RedeemPlugin } from '@loyaltyledger/core';
import { defaultEarnPlugin } from './default-earn.js';
import { nthFreeStampsPlugin } from './nth-free-stamps.js';
import { rollingTierPlugin } from './rolling-tier.js';
import { defaultRedeemPlugin } from './default-redeem.js';

export const receiptPlugins: ReceiptPlugin[] = [defaultEarnPlugin, nthFreeStampsPlugin, rollingTierPlugin];
export const redeemPlugins: RedeemPlugin[] = [defaultRedeemPlugin];
