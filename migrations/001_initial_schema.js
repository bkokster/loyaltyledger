'use strict';

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.createTable(
    'receipts',
    {
      receipt_id: { type: 'uuid', primaryKey: true },
      tenant_id: { type: 'text', notNull: true },
      idempotency_key: { type: 'text', notNull: true },
      fingerprint: { type: 'text', notNull: true },
      buyer_account_ref: { type: 'text', notNull: true },
      merchant_reference: { type: 'text', notNull: true },
      issued_at: { type: 'timestamptz', notNull: true },
      currency: { type: 'text', notNull: true },
      grand_total_cents: { type: 'bigint', notNull: true, check: 'grand_total_cents >= 0' },
      payload: { type: 'jsonb', notNull: true },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    { ifNotExists: true },
  );

  pgm.addConstraint('receipts', 'receipts_tenant_idempotency_unique', {
    unique: ['tenant_id', 'idempotency_key'],
  });

  pgm.addConstraint('receipts', 'receipts_tenant_fingerprint_unique', {
    unique: ['tenant_id', 'fingerprint'],
  });

  pgm.createTable(
    'ledger_journal',
    {
      entry_id: { type: 'uuid', primaryKey: true },
      tenant_id: { type: 'text', notNull: true },
      ts: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      program_id: { type: 'text', notNull: true },
      receipt_id: { type: 'uuid' },
      memo: { type: 'text' },
    },
    { ifNotExists: true },
  );

  pgm.createTable(
    'ledger_lines',
    {
      entry_id: {
        type: 'uuid',
        notNull: true,
        references: 'ledger_journal',
        onDelete: 'cascade',
      },
      line_no: { type: 'smallint', notNull: true },
      account_id: { type: 'text', notNull: true },
      dr: { type: 'bigint', notNull: true, default: 0, check: 'dr >= 0' },
      cr: { type: 'bigint', notNull: true, default: 0, check: 'cr >= 0' },
      unit: { type: 'text', notNull: true },
    },
    { ifNotExists: true },
  );
  pgm.addConstraint('ledger_lines', 'ledger_lines_pk', {
    primaryKey: ['entry_id', 'line_no'],
  });

  pgm.createTable(
    'tenant_api_keys',
    {
      tenant_id: { type: 'text', primaryKey: true },
      api_key_hash: { type: 'bytea', notNull: true },
      salt: { type: 'bytea', notNull: true },
      active: { type: 'boolean', notNull: true, default: true },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    { ifNotExists: true },
  );

  pgm.createTable(
    'receipt_jobs',
    {
      job_id: { type: 'uuid', primaryKey: true },
      tenant_id: { type: 'text', notNull: true },
      receipt_id: {
        type: 'uuid',
        notNull: true,
        references: 'receipts',
        onDelete: 'cascade',
      },
      status: { type: 'text', notNull: true, default: 'pending' },
      attempts: { type: 'integer', notNull: true, default: 0 },
      last_error: { type: 'text' },
      result_summary: { type: 'jsonb' },
      completed_at: { type: 'timestamptz' },
      available_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    { ifNotExists: true },
  );

  pgm.createTable(
    'redeem_requests',
    {
      request_id: { type: 'uuid', primaryKey: true },
      tenant_id: { type: 'text', notNull: true },
      account_id: { type: 'text', notNull: true },
      program_id: { type: 'text', notNull: true },
      unit: { type: 'text', notNull: true },
      qty: { type: 'bigint', notNull: true, check: 'qty > 0' },
      memo: { type: 'text' },
      idempotency_key: { type: 'text' },
      burn_merchant_id: { type: 'text' },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    { ifNotExists: true },
  );

  pgm.createTable(
    'redeem_jobs',
    {
      job_id: { type: 'uuid', primaryKey: true },
      tenant_id: { type: 'text', notNull: true },
      request_id: {
        type: 'uuid',
        notNull: true,
        references: 'redeem_requests',
        onDelete: 'cascade',
      },
      status: { type: 'text', notNull: true, default: 'pending' },
      attempts: { type: 'integer', notNull: true, default: 0 },
      last_error: { type: 'text' },
      result_summary: { type: 'jsonb' },
      completed_at: { type: 'timestamptz' },
      available_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    { ifNotExists: true },
  );

  pgm.createTable(
    'program_configs',
    {
      tenant_id: { type: 'text', notNull: true },
      program_id: { type: 'text', notNull: true },
      config: { type: 'jsonb', notNull: true, default: '{}' },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    { ifNotExists: true },
  );

  pgm.createTable(
    'merchant_status',
    {
      tenant_id: { type: 'text', notNull: true },
      merchant_account: { type: 'text', notNull: true },
      frozen: { type: 'boolean', notNull: true, default: false },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    { ifNotExists: true },
  );
  pgm.addConstraint('merchant_status', 'merchant_status_pk', { primaryKey: ['tenant_id', 'merchant_account'] });

  pgm.createTable(
    'job_notifications',
    {
      notification_id: { type: 'uuid', primaryKey: true },
      tenant_id: { type: 'text', notNull: true },
      job_type: { type: 'text', notNull: true },
      job_id: { type: 'uuid', notNull: true },
      reference_id: { type: 'uuid', notNull: true },
      status: { type: 'text', notNull: true },
      summary: { type: 'jsonb' },
      error: { type: 'text' },
      available_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      delivered_at: { type: 'timestamptz' },
      delivery_attempts: { type: 'integer', notNull: true, default: 0 },
    },
    { ifNotExists: true },
  );

  pgm.createTable(
    'settlement_reports',
    {
      report_id: { type: 'uuid', primaryKey: true },
      tenant_id: { type: 'text', notNull: true },
      merchant_account: { type: 'text', notNull: true },
      period_start: { type: 'timestamptz', notNull: true },
      period_end: { type: 'timestamptz', notNull: true },
      net_points: { type: 'bigint', notNull: true },
      summary: { type: 'jsonb' },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    { ifNotExists: true },
  );

  pgm.createIndex('ledger_lines', ['account_id', 'unit'], { name: 'idx_ledger_lines_account' });
  pgm.createIndex('ledger_journal', ['tenant_id', 'program_id'], { name: 'idx_ledger_journal_tenant' });
  pgm.createIndex('receipt_jobs', ['status', 'available_at'], { name: 'idx_receipt_jobs_status_available' });
  pgm.createIndex('redeem_jobs', ['status', 'available_at'], { name: 'idx_redeem_jobs_status_available' });
  pgm.createIndex('redeem_requests', ['tenant_id', 'idempotency_key'], {
    name: 'idx_redeem_requests_tenant_idempotency',
    unique: true,
    where: 'idempotency_key IS NOT NULL',
  });
  pgm.createIndex('program_configs', ['tenant_id', 'program_id'], {
    name: 'idx_program_configs_tenant_program',
    unique: true,
  });
  pgm.createIndex('job_notifications', ['delivered_at', 'available_at'], {
    name: 'idx_job_notifications_delivery',
  });
  pgm.createIndex('settlement_reports', ['tenant_id', 'merchant_account', 'period_start', 'period_end'], {
    name: 'idx_settlement_reports_unique',
    unique: true,
  });

  pgm.createTable(
    'point_lots',
    {
      lot_id: { type: 'uuid', primaryKey: true },
      tenant_id: { type: 'text', notNull: true },
      program_id: { type: 'text', notNull: true },
      unit: { type: 'text', notNull: true },
      customer_account: { type: 'text', notNull: true },
      merchant_id: { type: 'text' },
      earn_entry_id: { type: 'uuid' },
      qty_total: { type: 'bigint', notNull: true },
      qty_remaining: { type: 'bigint', notNull: true },
      expires_at: { type: 'timestamptz' },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    { ifNotExists: true },
  );

  pgm.createIndex('point_lots', ['tenant_id', 'customer_account', 'program_id', 'unit', 'expires_at'], {
    name: 'idx_point_lots_lookup',
  });

  pgm.createTable(
    'merchant_redemption_rules',
    {
      tenant_id: { type: 'text', notNull: true },
      earn_merchant_id: { type: 'text', notNull: true },
      earn_merchant_account: { type: 'text', notNull: true },
      burn_merchant_id: { type: 'text', notNull: true },
      expiry_days_override: { type: 'integer' },
      settlement_adjustment_bps: { type: 'integer' },
      enabled: { type: 'boolean', notNull: true, default: true },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    { ifNotExists: true },
  );
  pgm.addConstraint('merchant_redemption_rules', 'merchant_redemption_rules_pk', {
    primaryKey: ['tenant_id', 'earn_merchant_id', 'burn_merchant_id'],
  });
  pgm.createIndex('merchant_redemption_rules', ['tenant_id', 'burn_merchant_id'], {
    name: 'idx_redemption_rules_burn',
    where: 'enabled = TRUE',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('merchant_redemption_rules', { ifExists: true });
  pgm.dropTable('point_lots', { ifExists: true });
  pgm.dropTable('settlement_reports', { ifExists: true });
  pgm.dropTable('job_notifications', { ifExists: true });
  pgm.dropTable('program_configs', { ifExists: true });
  pgm.dropTable('redeem_jobs', { ifExists: true });
  pgm.dropTable('redeem_requests', { ifExists: true });
  pgm.dropTable('receipt_jobs', { ifExists: true });
  pgm.dropTable('tenant_api_keys', { ifExists: true });
  pgm.dropTable('ledger_lines', { ifExists: true });
  pgm.dropTable('ledger_journal', { ifExists: true });
  pgm.dropTable('receipts', { ifExists: true });
};
