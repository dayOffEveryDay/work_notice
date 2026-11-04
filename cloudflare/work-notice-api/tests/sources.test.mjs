import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHmac, createHash } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { applyTestMigrations } from '../scripts/migrations.mjs';
import { handle } from '../.build/index.js';
import { dispatchPush } from '../.build/fcm.js';
import { digest, protectToken } from '../.build/mobile.js';
import { effectiveStatus } from '../.build/database.js';

const sources = ['TELEGRAM', 'LARK_A_CHROME', 'LARK_B_BRAVE'];
const aumids = ['Telegram.TelegramDesktop', 'synthetic.chrome.lark', 'synthetic.brave.lark'];
const secret = randomBytes(32).toString('hex'), bearer = randomBytes(32).toString('hex');
const now = Date.now() + 600000; // controlled clock stays ahead of real-time final FCM checks
let mf, db, env;
before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'sources-local-only', modules: true,
    script: 'export default {fetch(){return new Response("local-only")}}', compatibilityDate: '2026-11-02', d1Databases: ['DB'] }));
  db = await mf.getD1Database('DB');
  await applyTestMigrations(db);
  env = { DB: db, AGENT_HMAC_SECRET: secret, ADMIN_API_KEY: randomBytes(32).toString('hex'), ALLOWED_DEVICE_IDS: 'home-windows',
    ALLOWED_TELEGRAM_AUMIDS: aumids[0], ALLOWED_LARK_A_CHROME_AUMIDS: aumids[1], ALLOWED_LARK_B_BRAVE_AUMIDS: aumids[2],
    FCM_PROJECT_ID: 'mock', FCM_SERVICE_ACCOUNT_JSON: 'mock', FCM_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex') };
});
after(async () => mf?.dispose());
beforeEach(async () => {
  for (const table of ['monitoring_commands', 'monitoring_settings', 'push_jobs', 'mobile_acks', 'android_devices', 'alert_events', 'alert_settings', 'request_nonces', 'agents', 'agent_status_transitions'])
    await db.prepare(`DELETE FROM ${table}`).run();
  await db.prepare('INSERT INTO android_devices(mobile_id,device_id,bearer_hash,created_at_ms,updated_at_ms,fcm_cipher) VALUES (?,?,?,?,?,?)')
    .bind('mobile-synthetic', 'home-windows', await digest(bearer), now - 1000, now, await protectToken(env, 'synthetic-fcm-token')).run();
});
function signed(path, body, time = now, signingSecret = secret, nonce = randomUUID().replaceAll('-', '')) {
  const raw = JSON.stringify(body), timestamp = String(Math.floor(time / 1000));
  const signature = createHmac('sha256', signingSecret).update(['POST', path, 'home-windows', timestamp, nonce,
    createHash('sha256').update(raw).digest('hex')].join('\n')).digest('hex');
  return new Request('http://localhost' + path, { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json',
    'X-Device-Id': 'home-windows', 'X-Timestamp': timestamp, 'X-Nonce': nonce, 'X-Signature': 'v1=' + signature } });
}
const alert = (i, occurred = now, extra = {}) => ({ deviceId: 'home-windows', eventId: 'a'.repeat(64), source: sources[i],
  aumid: aumids[i], notificationId: 42, occurredAt: new Date(occurred).toISOString(), ...extra });
const send = (i, occurred = now, received = now, extra = {}, customEnv = env) => handle(signed('/api/alert', alert(i, occurred, extra), received), customEnv, received);
async function monitoring(mode, revision = 0, time = now) {
  const response = await handle(new Request('http://localhost/api/mobile/monitoring', { method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bearer },
    body: JSON.stringify({ commandId: randomUUID(), expectedRevision: revision, mode, delayMinutes: mode === 'SCHEDULED' ? 1 : 0, urgentConsent: mode !== 'OFF' }) }), env, time);
  assert.equal(response.status, 200);
  return (await response.json()).monitoring;
}
const rows = async table => (await db.prepare(`SELECT * FROM ${table}`).all()).results;
async function push(time = now + 1, intercept) {
  const payloads = [];
  await dispatchPush(env, time, { send: async (_e, token, data, ttl, _n, _report, gate) => {
    assert.equal(token, 'synthetic-fcm-token');
    assert.ok(ttl > 0 && ttl <= 120);
    if (intercept) await intercept(data);
    if (!await gate()) return 'CANCELLED';
    payloads.push(data); return 'SENT_TO_FCM';
  } });
  return payloads;
}

test('all three source/AUMID pairs are distinct; identical wire IDs deduplicate independently without a schema key change', async () => {
  await monitoring('IMMEDIATE');
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const first = await send(i), repeat = await send(i);
    assert.equal(first.status, 202); assert.equal((await repeat.json()).status, 'DUPLICATE');
    ids.push((await first.json()).eventId);
  }
  assert.equal(new Set(ids).size, 3);
  assert.equal(ids[0], 'a'.repeat(64)); // legacy Telegram unchanged
  assert.ok(ids.every(id => /^[a-f0-9]{64}$/.test(id))); // Android 0.4.1.1 compatible
  assert.deepEqual((await rows('alert_events')).map(r => r.source).sort(), [...sources].sort());
  const data = await push();
  assert.equal(data.length, 3);
  assert.equal(new Set(data.map(p => p.eventId)).size, 3);
  assert.ok(data.every(p => p.type === 'WORK_ALERT' && p.monitoringRevision === '1' && p.monitoringSessionId));
});

test('browser allowlists default closed; unknown, cross-source, case mismatch and overlapping mappings are rejected', async () => {
  const empty = { ...env, ALLOWED_LARK_A_CHROME_AUMIDS: undefined, ALLOWED_LARK_B_BRAVE_AUMIDS: undefined };
  for (let i = 1; i < 3; i++) assert.equal((await send(i, now, now, {}, empty)).status, 400);
  for (let i = 0; i < 3; i++) {
    assert.equal((await send(i, now, now, { aumid: aumids[(i + 1) % 3] })).status, 400);
    assert.equal((await send(i, now, now, { aumid: aumids[i].toUpperCase() })).status, 400);
  }
  assert.equal((await send(0, now, now, { source: 'UNKNOWN' })).status, 400);
  const overlap = { ...env, ALLOWED_LARK_A_CHROME_AUMIDS: aumids[0] };
  assert.equal((await send(0, now, now, {}, overlap)).status, 400);
  assert.equal((await send(1, now, now, { aumid: aumids[0] }, overlap)).status, 400);
  assert.equal((await rows('alert_events')).length, 0);
});

for (let i = 0; i < 3; i++) {
  test(`${sources[i]}: OFF, SCHEDULED, delayed pre-start and replay never produce a push; only a new qualifying notification does`, async () => {
    await monitoring('OFF');
    await send(i);
    await monitoring('SCHEDULED', 1, now + 1);
    await send(i, now + 59000, now + 59000, { eventId: 'b'.repeat(64) });
    await send(i, now + 59000, now + 61001, { eventId: 'c'.repeat(64) });
    assert.equal((await rows('push_jobs')).length, 0);
    assert.equal((await push(now + 61002)).length, 0);
    assert.equal((await send(i, now, now + 61002)).status, 200); // OFF event retry after start
    assert.equal((await rows('push_jobs')).length, 0);
    await send(i, now + 61003, now + 61003, { eventId: 'd'.repeat(64) });
    const payload = (await push(now + 61004))[0];
    assert.equal(payload.monitoringRevision, '2');
    assert.equal(payload.occurredAt, new Date(now + 61003).toISOString());
    assert.equal((await rows('push_jobs')).length, 1);
  });

  test(`${sources[i]}: HMAC tampering, nonce replay, event expiry, session/revision change and pairing revocation stay enforced`, async () => {
    await monitoring('IMMEDIATE');
    assert.equal((await handle(signed('/api/alert', alert(i), now, 'wrong-key'), env, now)).status, 401);
    const req = signed('/api/alert', alert(i));
    assert.equal((await handle(new Request(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(alert(i, now, { source: 'UNKNOWN' })) }), env, now)).status, 401);
    const nonce = randomUUID().replaceAll('-', '');
    assert.equal((await handle(signed('/api/alert', alert(i), now, secret, nonce), env, now)).status, 202);
    assert.equal((await handle(signed('/api/alert', alert(i), now, secret, nonce), env, now)).status, 409);
    assert.equal((await send(i, now - 120001, now, { eventId: 'b'.repeat(64) })).status, 200);
    assert.equal((await rows('push_jobs')).length, 1);
    await db.prepare("UPDATE push_jobs SET monitoring_revision=999").run();
    assert.equal((await push()).length, 0);
    await send(i, now + 10, now + 10, { eventId: 'c'.repeat(64) });
    await db.prepare("UPDATE push_jobs SET monitoring_session_id='previous-session' WHERE state='PENDING'").run();
    assert.equal((await push(now + 10)).length, 0);
    await send(i, now + 11, now + 11, { eventId: 'e'.repeat(64) });
    assert.equal((await push(now + 11, async () => { await monitoring('OFF', 1, now + 11); })).length, 0);
    await monitoring('IMMEDIATE', 2, now + 20);
    await send(i, now + 21, now + 21, { eventId: 'd'.repeat(64) });
    await db.prepare('UPDATE android_devices SET revoked_at_ms=?').bind(now + 22).run();
    assert.equal((await push(now + 23)).length, 0);
    assert.equal((await db.prepare('SELECT mode FROM monitoring_settings').first()).mode, 'OFF');
  });
}

test('browser-only enabled sources yield healthy monitoring without claiming Telegram; legacy heartbeats still work', async () => {
  const body = { deviceId: 'home-windows', sessionId: 'agent-session', agentMode: 'MONITORING', listenerStatus: 'READY',
    notificationPermission: 'ALLOWED', telegramSourceConfirmed: false, agentVersion: '1.0.1', enabledSources: ['LARK_A_CHROME', 'LARK_B_BRAVE'] };
  assert.equal((await handle(signed('/api/heartbeat', body), env, now)).status, 200);
  let agent = (await rows('agents'))[0];
  assert.equal(agent.telegram_source_confirmed, 0); assert.equal(effectiveStatus(agent, now), 'MONITORING');
  assert.equal((await rows('agent_status_transitions'))[0].status, 'MONITORING');
  assert.equal((await handle(signed('/api/heartbeat', { ...body, enabledSources: [] }), env, now)).status, 200);
  assert.equal(effectiveStatus((await rows('agents'))[0], now), 'DEGRADED');
  const { enabledSources, ...legacy } = body;
  assert.equal((await handle(signed('/api/heartbeat', { ...legacy, telegramSourceConfirmed: true }), env, now)).status, 200);
  agent = (await rows('agents'))[0];
  assert.equal(agent.enabled_sources, null); assert.equal(effectiveStatus(agent, now), 'MONITORING');
  for (const list of [['UNKNOWN'], ['LARK_A_CHROME', 'LARK_A_CHROME'], ['TELEGRAM'], 'LARK_A_CHROME'])
    assert.equal((await handle(signed('/api/heartbeat', { ...body, enabledSources: list }), env, now)).status, 400);
});
