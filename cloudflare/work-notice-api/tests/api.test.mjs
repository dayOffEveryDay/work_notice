import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test, { before, after } from 'node:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { maintain, effectiveStatus } from '../.build/database.js';
import { handle } from '../.build/index.js';

const secret = randomBytes(32).toString('hex');
const adminKey = randomBytes(32).toString('hex');
let mf, db;
before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'api', modules: true, scriptPath: fileURLToPath(new URL('../.build/worker/index.js', import.meta.url)),
    compatibilityDate: '2026-11-02', d1Databases: ['DB'],
    bindings: { AGENT_HMAC_SECRET: secret, ADMIN_API_KEY: adminKey,
      ALLOWED_DEVICE_IDS: 'home-windows,other-windows', ALLOWED_TELEGRAM_AUMIDS: 'Telegram.TelegramDesktop' } }));
  db = await mf.getD1Database('DB');
  await (await import('../scripts/migrations.mjs')).applyTestMigrations(db);
  // D1.exec takes a single statement per line; batch keeps this exact SQL transactional.
  
});
after(async () => { await mf?.dispose(); });
const alert = (extra = {}) => ({ deviceId: 'home-windows', eventId: randomBytes(32).toString('hex'), source: 'TELEGRAM',
  aumid: 'Telegram.TelegramDesktop', notificationId: 123, occurredAt: new Date().toISOString(), ...extra });
const beat = (extra = {}) => ({ deviceId: 'home-windows', sessionId: 'session-current', agentMode: 'MONITORING',
  listenerStatus: 'READY', notificationPermission: 'ALLOWED', telegramSourceConfirmed: true, agentVersion: '1.0.0', ...extra });
function signed(path, body, options = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const device = options.device ?? 'home-windows';
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = options.nonce ?? randomUUID().replaceAll('-', '');
  const canonical = ['POST', path.split('?')[0], device, timestamp, nonce, createHash('sha256').update(raw).digest('hex')].join('\n');
  return new Request('http://localhost' + path, { method: 'POST', body: raw, headers: {
    'Content-Type': 'application/json', 'X-Device-Id': device, 'X-Timestamp': timestamp,
    'X-Nonce': nonce, 'X-Signature': 'v1=' + createHmac('sha256', options.secret ?? secret).update(canonical).digest('hex')
  } });
}
const dispatch = async request => mf.dispatchFetch(request.url, { method: request.method,
  headers: Object.fromEntries(request.headers), body: await request.text() });
const send = (path, body, options) => dispatch(signed(path, body, options));
const admin = (path, method = 'GET', body, key = adminKey) => mf.dispatchFetch('http://localhost' + path, {
  method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const status = async () => (await admin('/api/device/status?deviceId=home-windows')).json();

test('HMAC accepts exact raw bytes and rejects wrong key, tampering and timestamp', async () => {
  assert.equal((await send('/api/heartbeat', beat())).status, 200);
  assert.equal((await send('/api/heartbeat', beat(), { secret: randomBytes(32).toString('hex') })).status, 401);
  assert.equal((await send('/api/heartbeat', beat(), { timestamp: String(Math.floor(Date.now() / 1000) - 301) })).status, 401);
  assert.equal((await send('/api/heartbeat', beat(), { timestamp: String(Math.floor(Date.now() / 1000) + 301) })).status, 401);
  const original = signed('/api/heartbeat', beat());
  const tampered = new Request(original.url, { method: 'POST', headers: original.headers, body: JSON.stringify(beat({ agentMode: 'STANDBY' })) });
  assert.equal((await dispatch(tampered)).status, 401);
  const pretty = JSON.stringify(beat(), null, 2);
  assert.equal((await send('/api/heartbeat', pretty)).status, 200);
});
test('signed query strings, disallowed devices, unknown payload fields and oversized bodies fail closed', async () => {
  assert.equal((await send('/api/heartbeat?x=1', beat())).status, 400);
  assert.equal((await send('/api/heartbeat', beat({ deviceId: 'stranger' }), { device: 'stranger' })).status, 403);
  assert.equal((await send('/api/heartbeat', beat({ deviceId: 'other-windows' }))).status, 400);
  assert.equal((await send('/api/alert', alert({ text: 'must-not-be-saved' }))).status, 400);
  assert.equal((await send('/api/alert', alert({ aumid: 'browser' }))).status, 400);
  assert.equal((await send('/api/alert', alert({ notificationId: [1] }))).status, 400);
  assert.equal((await send('/api/alert', alert({ occurredAt: '2026-02-30T00:00:00Z' }))).status, 400);
  assert.equal((await send('/api/heartbeat', ' '.repeat(8193))).status, 413);
});
test('missing or reused server secrets fail closed without touching D1', async () => {
  const DB = { prepare() { assert.fail('Misconfigured security must not access D1'); } };
  for (const keys of [{}, { AGENT_HMAC_SECRET: secret, ADMIN_API_KEY: secret }]) {
    const response = await handle(signed('/api/heartbeat', beat()), { DB, ...keys, ALLOWED_DEVICE_IDS: 'home-windows' });
    assert.equal(response.status, 503);
  }
});
test('verified malformed requests consume nonce, while forged signatures cannot consume it', async () => {
  const nonce = randomUUID().replaceAll('-', '');
  assert.equal((await send('/api/heartbeat', beat({ agentMode: 'INVALID' }), { nonce })).status, 400);
  assert.equal((await send('/api/heartbeat', beat(), { nonce })).status, 409);
  const forged = randomUUID().replaceAll('-', '');
  assert.equal((await send('/api/heartbeat', beat(), { nonce: forged, secret: randomBytes(32).toString('hex') })).status, 401);
  assert.equal((await send('/api/heartbeat', beat(), { nonce: forged })).status, 200);
});
test('nonce replay is atomic even with concurrent requests and future timestamps survive cleanup', async () => {
  const nonce = randomUUID().replaceAll('-', '');
  const timestamp = String(Math.floor(Date.now() / 1000) + 299);
  const responses = await Promise.all([send('/api/heartbeat', beat(), { nonce, timestamp }), send('/api/heartbeat', beat(), { nonce, timestamp })]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  await maintain(db, Date.now() + 301000);
  assert.equal((await send('/api/heartbeat', beat(), { nonce, timestamp })).status, 409);
});
test('admin APIs reject agent secret, anonymous requests and device enumeration', async () => {
  assert.equal((await admin('/api/device/status?deviceId=home-windows', 'GET', undefined, secret)).status, 401);
  assert.equal((await mf.dispatchFetch('http://localhost/api/device/status?deviceId=home-windows')).status, 401);
  assert.equal((await admin('/api/device/status')).status, 400);
  assert.equal((await admin('/api/device/status?deviceId=stranger')).status, 403);
});
test('env.DB persists one alert for concurrent event IDs and keeps payload metadata only', async () => {
  const event = alert();
  const responses = await Promise.all([send('/api/alert', event), send('/api/alert', event)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 202]);
  assert.deepEqual((await Promise.all(responses.map(r => r.json()))).map(r => r.status).sort(), ['ACCEPTED', 'DUPLICATE']);
  const records = await db.prepare('SELECT * FROM alert_events WHERE device_id=? AND event_id=?').bind(event.deviceId, event.eventId).all();
  assert.equal(records.results.length, 1);
  assert.equal(records.results[0].aumid, event.aumid);
  assert.equal(records.results[0].should_notify, 0);
  assert.equal((await db.prepare('SELECT count(*) AS count FROM agents WHERE device_id=?').bind(event.deviceId).first()).count, 1);
});
test('stale events are stored STALE without notification even when settings are enabled', async () => {
  await admin('/api/device/settings', 'PUT', { deviceId: 'home-windows', enabled: true, mode: 'UNTIL_MANUALLY_DISABLED' });
  const event = alert({ occurredAt: new Date(Date.now() - 121000).toISOString() });
  const response = await send('/api/alert', event);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'STALE');
  assert.equal((await db.prepare('SELECT should_notify FROM alert_events WHERE device_id=? AND event_id=?').bind(event.deviceId, event.eventId).first()).should_notify, 0);
});
test('settings support persistent, timed, expiry and immediate disable with server time', async () => {
  const start = Date.now();
  const timed = await admin('/api/device/settings', 'PUT', { deviceId: 'home-windows', enabled: true, mode: 'TIMED', durationMinutes: 150 });
  assert.equal(timed.status, 200);
  const expires = Date.parse((await timed.json()).expiresAt);
  assert.ok(expires >= start + 150 * 60000 && expires <= Date.now() + 150 * 60000);
  assert.equal((await status()).alertSetting.effectiveEnabled, true);
  const fresh = alert();
  await send('/api/alert', fresh);
  assert.equal((await db.prepare('SELECT should_notify FROM alert_events WHERE event_id=?').bind(fresh.eventId).first()).should_notify, 1);
  await db.prepare('UPDATE alert_settings SET expires_at_ms=? WHERE device_id=?').bind(Date.now() - 1, 'home-windows').run();
  assert.equal((await status()).alertSetting.effectiveEnabled, false);
  await admin('/api/device/settings', 'PUT', { deviceId: 'home-windows', enabled: false, mode: 'UNTIL_MANUALLY_DISABLED' });
  assert.equal((await status()).alertSetting.effectiveEnabled, false);
  assert.equal((await admin('/api/device/settings', 'PUT', { deviceId: 'home-windows', enabled: true, mode: 'TIMED', durationMinutes: -1 })).status, 400);
});
test('heartbeat distinguishes standby, degraded, normal stop and recovery without growing agents rows', async () => {
  await send('/api/heartbeat', beat({ agentMode: 'STANDBY' }));
  assert.equal((await status()).effectiveStatus, 'STANDBY');
  await send('/api/heartbeat', beat({ notificationPermission: 'DENIED' }));
  assert.equal((await status()).effectiveStatus, 'DEGRADED');
  await send('/api/heartbeat', beat({ agentMode: 'STOPPED_BY_USER' }));
  await db.prepare('UPDATE agents SET last_seen_at_ms=? WHERE device_id=?').bind(Date.now() - 999000, 'home-windows').run();
  await maintain(db, Date.now());
  assert.equal((await status()).effectiveStatus, 'STOPPED_BY_USER');
  await send('/api/heartbeat', beat({ sessionId: 'session-recovery' }));
  assert.equal((await status()).effectiveStatus, 'MONITORING');
  assert.equal((await send('/api/heartbeat', beat({ agentMode: 'STOPPED_BY_USER' }))).status, 409);
  assert.equal((await status()).effectiveStatus, 'MONITORING');
});
test('180-second boundary, offline live computation, cron idempotency and cleanup use actual D1', async () => {
  const now = Date.now();
  const agent = { last_seen_at_ms: now - 180000, reported_mode: 'MONITORING', listener_status: 'READY', notification_permission: 'ALLOWED', telegram_source_confirmed: 1 };
  assert.equal(effectiveStatus(agent, now), 'MONITORING');
  assert.equal(effectiveStatus(agent, now + 1), 'OFFLINE');
  assert.equal(effectiveStatus(null, now), 'UNKNOWN');
  await db.prepare('UPDATE agents SET last_seen_at_ms=? WHERE device_id=?').bind(now - 181000, 'home-windows').run();
  assert.equal((await status()).effectiveStatus, 'OFFLINE'); // no cron needed for GET
  await Promise.all([maintain(db, now), maintain(db, now)]);
  const count = await db.prepare('SELECT count(*) AS count FROM agent_status_transitions WHERE device_id=?').bind('home-windows').first();
  await maintain(db, now + 1);
  assert.deepEqual(await db.prepare('SELECT count(*) AS count FROM agent_status_transitions WHERE device_id=?').bind('home-windows').first(), count);
  await db.prepare('INSERT INTO request_nonces(device_id,nonce,expires_at_ms) VALUES (?,?,?)').bind('home-windows', 'expired-fixture', now - 1).run();
  await db.prepare('UPDATE alert_events SET received_at_ms=?').bind(now - 8 * 86400000).run();
  await maintain(db, now);
  assert.equal((await db.prepare('SELECT count(*) AS count FROM alert_events').first()).count, 0);
  assert.equal((await db.prepare('SELECT count(*) AS count FROM request_nonces WHERE nonce=?').bind('expired-fixture').first()).count, 0);
  await send('/api/heartbeat', beat({ sessionId: 'session-recovery' }));
  assert.equal((await status()).effectiveStatus, 'MONITORING');
});
