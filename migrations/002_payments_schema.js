'use strict';

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.createTable(
    'payment_accounts',
    {
      tenant_id: { type: 'text', notNull: true },
      merchant_id: { type: 'text', notNull: true },
      psp: { type: 'text', notNull: true, default: 'stripe' },
      psp_account_id: { type: 'text', notNull: true },
      currency: { type: 'text', notNull: true, default: 'USD' },
      payout_schedule: { type: 'text', notNull: true, default: 'monthly' },
      status: { type: 'text', notNull: true, default: 'active' },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    { ifNotExists: true },
  );
  pgm.addConstraint('payment_accounts', 'payment_accounts_pk', {
    primaryKey: ['tenant_id', 'merchant_id'],
  });
  pgm.createIndex('payment_accounts', ['tenant_id', 'status'], {
    name: 'idx_payment_accounts_tenant_status',
  });
  pgm.createIndex('payment_accounts', ['tenant_id', 'merchant_id'], {
    name: 'idx_payment_accounts_lookup',
  });

  pgm.createTable(
    'payout_batches',
    {
      batch_id: { type: 'uuid', primaryKey: true },
      tenant_id: { type: 'text', notNull: true },
      period_start: { type: 'timestamptz', notNull: true },
      period_end: { type: 'timestamptz', notNull: true },
      currency: { type: 'text', notNull: true },
      status: { type: 'text', notNull: true, default: 'open' },
      summary: { type: 'jsonb' },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    { ifNotExists: true },
  );
  pgm.createIndex('payout_batches', ['tenant_id', 'period_start', 'period_end'], {
    name: 'idx_payout_batches_unique_period',
    unique: true,
  });

  pgm.createTable(
    'payout_items',
    {
      item_id: { type: 'uuid', primaryKey: true },
      batch_id: {
        type: 'uuid',
        notNull: true,
        references: 'payout_batches',
        onDelete: 'cascade',
      },
      tenant_id: { type: 'text', notNull: true },
      merchant_account: { type: 'text', notNull: true },
      merchant_id: { type: 'text' },
      points_settled: { type: 'bigint', notNull: true },
      rate_cents_per_point: { type: 'integer', notNull: true },
      gross_cents: { type: 'bigint', notNull: true, check: 'gross_cents >= 0' },
      platform_fee_bps: { type: 'integer', notNull: true },
      fee_cents: { type: 'bigint', notNull: true, check: 'fee_cents >= 0' },
      settlement_adj_bps: { type: 'integer' },
      adj_cents: { type: 'bigint', notNull: true, default: 0 },
      net_cents: { type: 'bigint', notNull: true },
      direction: { type: 'text', notNull: true },
      psp: { type: 'text', notNull: true },
      psp_transfer_id: { type: 'text' },
      status: { type: 'text', notNull: true, default: 'pending' },
      error: { type: 'text' },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    { ifNotExists: true },
  );
  pgm.createIndex('payout_items', ['tenant_id', 'status'], {
    name: 'idx_payout_items_tenant_status',
  });
  pgm.createIndex('payout_items', ['batch_id'], { name: 'idx_payout_items_batch' });
  pgm.createIndex('payout_items', ['tenant_id', 'psp_transfer_id'], {
    name: 'idx_payout_items_psp_transfer',
  });
  pgm.addConstraint('payout_items', 'payout_items_batch_merchant_unique', {
    unique: ['batch_id', 'merchant_account'],
  });

  pgm.createTable(
    'collections',
    {
      collection_id: { type: 'uuid', primaryKey: true },
      tenant_id: { type: 'text', notNull: true },
      payout_item_id: {
        type: 'uuid',
        notNull: true,
        references: 'payout_items',
        onDelete: 'cascade',
      },
      merchant_id: { type: 'text', notNull: true },
      merchant_account: { type: 'text', notNull: true },
      amount_cents: { type: 'bigint', notNull: true, check: 'amount_cents > 0' },
      currency: { type: 'text', notNull: true },
      psp: { type: 'text', notNull: true },
      psp_debit_id: { type: 'text' },
      attempts: { type: 'integer', notNull: true, default: 0 },
      status: { type: 'text', notNull: true, default: 'pending' },
      error: { type: 'text' },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    { ifNotExists: true },
  );
  pgm.addConstraint('collections', 'collections_item_unique', {
    unique: ['payout_item_id'],
  });
  pgm.createIndex('collections', ['tenant_id', 'status'], {
    name: 'idx_collections_tenant_status',
  });

  pgm.createTable(
    'payment_events',
    {
      event_id: { type: 'uuid', primaryKey: true },
      tenant_id: { type: 'text', notNull: true },
      psp: { type: 'text', notNull: true },
      psp_event_type: { type: 'text', notNull: true },
      psp_object_id: { type: 'text', notNull: true },
      payload: { type: 'jsonb', notNull: true },
      received_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    { ifNotExists: true },
  );
  pgm.createIndex('payment_events', ['tenant_id', 'psp_object_id'], {
    name: 'idx_payment_events_lookup',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('payment_events', { ifExists: true });
  pgm.dropTable('collections', { ifExists: true });
  pgm.dropTable('payout_items', { ifExists: true });
  pgm.dropTable('payout_batches', { ifExists: true });
  pgm.dropTable('payment_accounts', { ifExists: true });
};
