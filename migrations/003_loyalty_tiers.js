'use strict';

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.createTable(
    'customer_tiers',
    {
      tenant_id: { type: 'text', notNull: true },
      merchant_id: { type: 'text', notNull: true },
      customer_account: { type: 'text', notNull: true },
      customer_account_ref: { type: 'text', notNull: true },
      tier_id: { type: 'text', notNull: true },
      tier_name: { type: 'text' },
      window_days: { type: 'integer', notNull: true },
      window_start: { type: 'timestamptz', notNull: true },
      window_end: { type: 'timestamptz', notNull: true },
      rolling_spend_cents: { type: 'bigint', notNull: true },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    { ifNotExists: true },
  );

  pgm.addConstraint('customer_tiers', 'customer_tiers_pk', {
    primaryKey: ['tenant_id', 'merchant_id', 'customer_account'],
  });

  pgm.createIndex('customer_tiers', ['tenant_id', 'merchant_id', 'tier_id'], {
    name: 'idx_customer_tiers_tenant_merchant_tier',
  });
  pgm.createIndex('customer_tiers', ['tenant_id', 'customer_account'], {
    name: 'idx_customer_tiers_customer_lookup',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('customer_tiers', { ifExists: true });
};
