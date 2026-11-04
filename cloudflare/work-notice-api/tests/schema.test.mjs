import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { before } from 'node:test';
import { queryLocal, runLocal } from '../scripts/wrangler-local.mjs';

// Each run owns an isolated local D1. Test rows never enter the development DB or remote D1.
const state = `.wrangler/schema-tests/${randomUUID()}`;
const names = ['monitoring_commands', 'monitoring_settings', 'agent_status_transitions', 'agents', 'alert_events', 'alert_settings', 'android_devices', 'mobile_acks', 'mobile_pairings', 'mobile_rate_limits', 'push_jobs', 'request_nonces'];
const query = sql => queryLocal(sql, state);
const rows = async sql => (await query(sql))[0].results;
const migrate = () => runLocal(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state]);
const rejectsConstraint = sql => assert.rejects(() => query(sql), error =>
  /constraint/i.test(`${error.message}\n${error.stdout}\n${error.stderr}`));

before(async () => { await migrate(); });

test('migration is byte-for-byte the provided phase-two SQL', async () => {
  const original = await readFile(new URL('../../../docs/WorkNotice_Phase2_0001_init.sql', import.meta.url));
  const migration = await readFile(new URL('../migrations/0001_init.sql', import.meta.url));
  assert.deepEqual(migration, original);
});

test('real local D1 preserves five phase-two tables and adds phase-three tables', async () => {
  const tables = await rows("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name");
  const application = tables.map(row => row.name).filter(name =>
    !name.startsWith('_cf_') && !name.startsWith('sqlite_') && name !== 'd1_migrations');
  assert.deepEqual(application, [...names].sort());
});

test('primary keys, required fields and cleanup indexes match the supplied schema', async () => {
  const results = await query("PRAGMA table_info(agents); PRAGMA table_info(alert_events); PRAGMA table_info(request_nonces); SELECT name FROM sqlite_schema WHERE type='index' AND name LIKE 'idx_%' ORDER BY name;");
  assert.deepEqual(results[0].results.filter(column => column.pk).map(column => [column.name, column.pk]), [['device_id', 1]]);
  assert.deepEqual(results[1].results.filter(column => column.pk).map(column => [column.name, column.pk]), [['device_id', 1], ['event_id', 2]]);
  assert.deepEqual(results[2].results.filter(column => column.pk).map(column => [column.name, column.pk]), [['device_id', 1], ['nonce', 2]]);
  assert.equal(results[0].results.find(column => column.name === 'created_at_ms').notnull, 1);
  assert.equal(results[1].results.find(column => column.name === 'occurred_at_ms').notnull, 1);
  assert.deepEqual(results[3].results.map(row => row.name), ['idx_alert_events_received_at', 'idx_request_nonces_expires']);
});

test('agents defaults are standby, error, unknown and unconfirmed with UTC epoch milliseconds intact', async () => {
  await query("INSERT INTO agents(device_id, created_at_ms, updated_at_ms) VALUES ('defaults', 1793600000000, 1793600000000)");
  assert.deepEqual(await rows("SELECT display_name,reported_mode,listener_status,notification_permission,telegram_source_confirmed,last_seen_at_ms,created_at_ms FROM agents WHERE device_id='defaults'"), [{
    display_name: 'Windows PC', reported_mode: 'STANDBY', listener_status: 'ERROR',
    notification_permission: 'UNKNOWN', telegram_source_confirmed: 0,
    last_seen_at_ms: null, created_at_ms: 1793600000000
  }]);
  await rejectsConstraint("INSERT INTO agents(device_id, created_at_ms, updated_at_ms) VALUES ('defaults', 1, 1)");
});

test('same device and event ID are unique while another device may use that event ID', async () => {
  const insert = "INSERT INTO alert_events(device_id,event_id,source,aumid,notification_id,occurred_at_ms,received_at_ms,result) VALUES ('events-a','same-event','TELEGRAM','Telegram.TelegramDesktop','4294967295',1793600000000,1793600001000,'ACCEPTED')";
  await query(insert);
  await rejectsConstraint(insert);
  await query("INSERT INTO alert_events(device_id,event_id,source,aumid,notification_id,occurred_at_ms,received_at_ms,result) VALUES ('events-b','same-event','TELEGRAM','Telegram.TelegramDesktop','1',1793600000000,1793600001000,'ACCEPTED')");
  assert.deepEqual(await rows("SELECT count(*) AS count, max(should_notify) AS should_notify FROM alert_events WHERE event_id='same-event'"), [{ count: 2, should_notify: 0 }]);
  await rejectsConstraint("INSERT INTO alert_events(device_id,event_id,source,notification_id,occurred_at_ms,received_at_ms,result) VALUES ('missing','missing','TELEGRAM','1',1,1,'ACCEPTED')");
});

test('nonce uniqueness is per device and expiry remains queryable for cleanup', async () => {
  const insert = "INSERT INTO request_nonces(device_id,nonce,expires_at_ms) VALUES ('nonce-a','same-nonce',1793600300000)";
  await query(insert);
  await rejectsConstraint(insert);
  await query("INSERT INTO request_nonces(device_id,nonce,expires_at_ms) VALUES ('nonce-b','same-nonce',1793600300000)");
  assert.deepEqual(await rows("SELECT count(*) AS count FROM request_nonces WHERE nonce='same-nonce' AND expires_at_ms <= 1793600300000"), [{ count: 2 }]);
});

test('alert settings default off, support timed expiry and reject non-boolean enabled', async () => {
  await query("INSERT INTO alert_settings(device_id,updated_at_ms) VALUES ('settings',1793600000000)");
  assert.deepEqual(await rows("SELECT enabled,mode,expires_at_ms FROM alert_settings WHERE device_id='settings'"), [{ enabled: 0, mode: 'UNTIL_MANUALLY_DISABLED', expires_at_ms: null }]);
  await query("UPDATE alert_settings SET enabled=1,mode='TIMED',expires_at_ms=1793609000000 WHERE device_id='settings'");
  assert.deepEqual(await rows("SELECT enabled,mode,expires_at_ms FROM alert_settings WHERE device_id='settings'"), [{ enabled: 1, mode: 'TIMED', expires_at_ms: 1793609000000 }]);
  await rejectsConstraint("UPDATE alert_settings SET enabled=2 WHERE device_id='settings'");
  await query("UPDATE alert_settings SET enabled=0 WHERE device_id='settings'");
  assert.deepEqual(await rows("SELECT enabled FROM alert_settings WHERE device_id='settings'"), [{ enabled: 0 }]);
});

test('transition history uses distinct increasing IDs', async () => {
  await query("INSERT INTO agent_status_transitions(device_id,status,observed_at_ms) VALUES ('transitions','OFFLINE',1793600000000),('transitions','MONITORING',1793600060000)");
  const transitions = await rows("SELECT id,status FROM agent_status_transitions WHERE device_id='transitions' ORDER BY id");
  assert.deepEqual(transitions.map(row => row.status), ['OFFLINE', 'MONITORING']);
  assert.ok(transitions[1].id > transitions[0].id);
});

test('events and nonces can arrive before heartbeat: no forced foreign keys', async () => {
  const foreignKeys = await query(names.map(name => `PRAGMA foreign_key_list(${name});`).join(' '));
  assert.ok(foreignKeys.every(result => result.results.length === 0));
  assert.deepEqual(await rows("SELECT count(*) AS count FROM agents WHERE device_id IN ('events-a','nonce-a')"), [{ count: 0 }]);
  assert.deepEqual(await rows("PRAGMA foreign_key_check"), []);
});

test('reapplying Wrangler migrations preserves data and records the migration once', async () => {
  const before = await rows("SELECT * FROM agents WHERE device_id='defaults'");
  await migrate();
  assert.deepEqual(await rows("SELECT * FROM agents WHERE device_id='defaults'"), before);
  assert.deepEqual(await rows("SELECT count(*) AS count FROM d1_migrations WHERE name='0001_init.sql'"), [{ count: 1 }]);
});
