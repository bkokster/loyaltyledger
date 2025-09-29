import { randomBytes, scryptSync } from 'crypto';

const [tenantId, apiKey] = process.argv.slice(2);

if (!tenantId || !apiKey) {
  console.error('Usage: pnpm --filter api... exec tsx scripts/hash-api-key.ts <tenantId> <apiKey>');
  process.exit(1);
}

const salt = randomBytes(16);
const hash = scryptSync(apiKey, salt, 32);

const saltHex = '\\x' + salt.toString('hex');
const hashHex = '\\x' + hash.toString('hex');

console.log('INSERT INTO tenant_api_keys (tenant_id, api_key_hash, salt) VALUES ($1, $2, $3)');
console.log('Values: ', tenantId, hashHex, saltHex);
console.log('Example psql command:');
console.log(
  `INSERT INTO tenant_api_keys (tenant_id, api_key_hash, salt) VALUES ('${tenantId}', '${hashHex}', '${saltHex}') ON CONFLICT (tenant_id) DO UPDATE SET api_key_hash = EXCLUDED.api_key_hash, salt = EXCLUDED.salt, active = true;`,
);
