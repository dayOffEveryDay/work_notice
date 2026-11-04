import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import worker from '../.build/index.js';

test('configuration binds the existing DB and keeps development local', async () => {
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.name, 'work-notice-api');
  assert.deepEqual(config.triggers.crons, ['* * * * *']);
  assert.deepEqual(config.d1_databases, [{
    binding: 'DB', database_name: 'work-notice-db',
    database_id: '27e8ee1c-bcb7-4ee5-94d7-40c589480395',
    migrations_dir: 'migrations', remote: false
  }]);
});

test('health follows the specification and does not disclose or query device data', async () => {
  const DB = { prepare() { assert.fail('Health should not query D1'); } };
  const response = await worker.fetch(new Request('http://localhost/api/health'), { DB });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('legacy undocumented health path is not exposed', async () => {
  const response = await worker.fetch(new Request('http://localhost/health'), {});
  assert.equal(response.status, 404);
});

test('unimplemented routes and writes do not access D1', async () => {
  const DB = { prepare() { assert.fail('Unexpected database query'); } };
  const missing = await worker.fetch(new Request('http://localhost/api/alert'), { DB });
  assert.equal(missing.status, 404);
  const write = await worker.fetch(new Request('http://localhost/api/health', { method: 'POST' }), { DB });
  assert.equal(write.status, 405);
  assert.equal(write.headers.get('Allow'), 'GET');
});
