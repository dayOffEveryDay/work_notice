import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash, createHmac, generateKeyPairSync, verify } from 'node:crypto';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { runLocal, projectDirectory } from '../../scripts/wrangler-local.mjs';
import { digest, protectToken } from '../../.build/mobile.js';

export const legacyTables = ['agents', 'alert_events', 'alert_settings', 'request_nonces',
  'agent_status_transitions', 'android_devices', 'mobile_pairings', 'push_jobs', 'mobile_acks', 'mobile_rate_limits'];
export const migrationFiles = ['0001_init.sql', '0002_android_fcm.sql', '0003_scheduled_activation.sql', '0004_agent_sources.sql'];
export const migrationHashes = [
  'f2cee7b6a0d6af65e76d3c13f3e0b91b52dcd2c2b1221d03a90e2a87b023e3c9',
  'cb3d2f152275fa336ad7c9b5a78cb87546d6a7d4d61e700fedaffc9824b6d067',
  '65faa1a1817e051e2e58d814065a5dd0b5a95a707bdb63b0f3412618f9fdd303',
  '318e2073545043a5e628389ee5c49e50e63c75d76c77ea3c773687859796445c'
];
export const legacyHash = '0b5676826fef6238d2e1fe4cb370bf26ed96947acdbf9cb87079313d9bcfdd4d';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const normalizedSql = value => value.replace(/^--.*$/gm, '').replace(/;\s*$/, '').replace(/\s+/g, ' ').trim();

export async function snapshot(db, tables = legacyTables) {
  const result = {};
  for (const table of tables) {
    const columns = (await db.prepare(`PRAGMA table_info(${table})`).all()).results;
    const primaryKey = columns.filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name);
    const order = primaryKey.length ? primaryKey.map(c => `"${c}"`).join(',') : 'rowid';
    const indexes = (await db.prepare(`PRAGMA index_list(${table})`).all()).results;
    const indexDetails = [];
    for (const index of indexes) {
      indexDetails.push({ ...index,
        columns: (await db.prepare(`PRAGMA index_xinfo("${index.name}")`).all()).results,
        sql: (await db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?").bind(index.name).first())?.sql ?? null });
    }
    result[table] = {
      columns, primaryKey, indexes: indexDetails,
      foreignKeys: (await db.prepare(`PRAGMA foreign_key_list(${table})`).all()).results,
      sql: (await db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").bind(table).first()).sql,
      rows: (await db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()).results
    };
  }
  return result;
}

// The clock/header/dispatch endpoint exists only in these in-memory test entrypoints.
// Policy, SQL, authentication, OAuth and FCM code are imported unchanged.
const adapter = `
export default { async fetch(request, env) {
  if(request.headers.get('X-B1-Control')!==env.B1_CONTROL) return new Response(null,{status:403});
  const now=Number(request.headers.get('X-B1-Now'));
  if(!Number.isSafeInteger(now)||now<=0) throw new Error('Invalid B1 clock');
  if(new URL(request.url).pathname==='/__b1/dispatch') {
    await dispatchPush(env,now); return Response.json({status:'mock-dispatch-complete'});
  }
  return handle(request,env,now);
}};`;

export class UpgradeFixture {
  constructor() {
    this.id = randomUUID();
    this.root = path.join(projectDirectory, '.wrangler', 'b1-upgrade', this.id);
    this.persist = path.join(this.root, 'state');
    this.config = path.join(this.root, 'wrangler.json');
    this.databaseId = randomUUID();
    this.artifacts = fileURLToPath(new URL(`../../../../artifacts/phase3/b1-upgrade/${this.id}/`, import.meta.url));
    // Deterministic logical time stays ahead of real wall time for final-send TTL checks.
    this.now = Date.now() + 600000;
    this.started = this.now;
    this.cases = [
      { id: 'b1-off', enabled: 0, mode: 'UNTIL_MANUALLY_DISABLED', expiry: null },
      { id: 'b1-always', enabled: 1, mode: 'UNTIL_MANUALLY_DISABLED', expiry: null },
      { id: 'b1-timed', enabled: 1, mode: 'TIMED', expiry: this.now + 86400000 },
      { id: 'b1-expired', enabled: 1, mode: 'TIMED', expiry: this.now - 1 }
    ];
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.publicKey = keys.publicKey;
    this.bindings = {
      AGENT_HMAC_SECRET: randomBytes(32).toString('hex'), ADMIN_API_KEY: randomBytes(32).toString('hex'),
      FCM_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex'), FCM_PROJECT_ID: 'b1-mock-project',
      FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({ type: 'service_account', project_id: 'b1-mock-project',
        client_email: 'synthetic@b1-mock.iam.gserviceaccount.com', private_key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) }),
      ALLOWED_DEVICE_IDS: this.cases.map(c => c.id).join(','), ALLOWED_TELEGRAM_AUMIDS: 'Telegram.TelegramDesktop',
      B1_CONTROL: randomBytes(32).toString('hex')
    };
    this.tokens = new Map(this.cases.map(c => [c.id, randomBytes(32).toString('hex')]));
    this.sent = [];
    this.oauth = [];
    this.env = { ...this.bindings };
  }
  local(args) {
    // The config and storage belong to this UUID only; never use project production config.
    return runLocal([...args, '--config', this.config, '--local', '--persist-to', this.persist]);
  }
  async migrate() { return this.local(['d1', 'migrations', 'apply', 'DB']); }
  async setup0002() {
    await mkdir(path.join(this.root, 'migrations'), { recursive: true });
    await mkdir(this.artifacts, { recursive: true });
    await writeFile(this.config, JSON.stringify({ name: 'b1-local-only', compatibility_date: '2026-11-02',
      d1_databases: [{ binding: 'DB', database_name: `b1-local-${this.id}`, database_id: this.databaseId,
        migrations_dir: 'migrations', remote: false }] }, null, 2));
    for (const file of migrationFiles.slice(0, 2)) {
      await copyFile(path.join(projectDirectory, 'migrations', file), path.join(this.root, 'migrations', file));
    }
    await this.migrate();
    await this.open();
    assert.equal(await this.db.prepare("SELECT name FROM sqlite_schema WHERE name='monitoring_settings'").first(), null);
    await this.seed();
    this.before = await snapshot(this.db);
    this.beforeLedger = (await this.db.prepare('SELECT * FROM d1_migrations ORDER BY id').all()).results;
    this.beforeTriggers = (await this.db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all()).results;
    await writeFile(path.join(this.artifacts, 'before-0002.json'), JSON.stringify({ tables: this.before, ledger: this.beforeLedger, triggers: this.beforeTriggers }, null, 2));
    // Close workerd before the CLI opens exactly the same SQLite storage.
    await this.close();
    for (const file of migrationFiles.slice(2)) await copyFile(path.join(projectDirectory, 'migrations', file), path.join(this.root, 'migrations', file));
    await this.migrate();
    await this.open(true);
    this.after = await snapshot(this.db);
    this.afterLedger = (await this.db.prepare('SELECT * FROM d1_migrations ORDER BY id').all()).results;
    this.afterTriggers = (await this.db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all()).results;
    await writeFile(path.join(this.artifacts, 'after-0003.json'), JSON.stringify({ tables: this.after, ledger: this.afterLedger, triggers: this.afterTriggers }, null, 2));
  }
  async open(runtime = false) {
    const base = { modules: true, compatibilityDate: '2026-11-02', d1Databases: { DB: this.databaseId }, bindings: this.bindings };
    const options = { resourcePersistencePath: path.join(this.persist, 'v3') };
    if (!runtime) Object.assign(options, base, { name: 'b1-seed', script: 'export default {fetch(){return new Response("local-only")}}' });
    else {
      const old = await readFile(new URL('../fixtures/legacy-worker-0002.mjs', import.meta.url));
      assert.equal(sha256(old), legacyHash, 'frozen local legacy Worker changed');
      // Add only a test export; no old Worker function body is patched or reconstructed.
      const oldPath = path.join(this.root, 'legacy-test-exports.mjs');
      await writeFile(oldPath, old.toString() + '\nexport { dispatchPush };\n');
      const entries = {
        current: `import {handle} from ${JSON.stringify(path.join(projectDirectory, '.build/index.js'))};\nimport {dispatchPush} from ${JSON.stringify(path.join(projectDirectory, '.build/fcm.js'))};`,
        legacy: `import {handle,dispatchPush} from ${JSON.stringify(oldPath)};`
      };
      options.workers = [];
      for (const [name, imports] of Object.entries(entries)) {
        const bundled = await build({ stdin: { contents: imports + adapter, resolveDir: projectDirectory },
          bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false, logLevel: 'silent' });
        options.workers.push({ ...base, name, script: bundled.outputFiles[0].text,
          outboundService: request => this.mockOutbound(name, request) });
      }
    }
    this.mf = new Miniflare(convertV4MiniflareOptions(options));
    this.db = await this.mf.getD1Database('DB', runtime ? 'current' : 'b1-seed');
    this.env.DB = this.db;
  }
  async close() { if (this.mf) { await this.mf.dispose(); this.mf = undefined; } }
  async mockOutbound(worker, request) {
    const url = new URL(request.url);
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') {
      const form = new URLSearchParams(await request.text());
      assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      const [a, b, sig] = form.get('assertion').split('.');
      assert.ok(verify('RSA-SHA256', Buffer.from(a + '.' + b), this.publicKey, Buffer.from(sig, 'base64url')));
      assert.equal(JSON.parse(Buffer.from(b, 'base64url')).aud, 'https://oauth2.googleapis.com/token');
      this.oauth.push(worker);
      return Response.json({ access_token: 'b1-synthetic-access-not-real', expires_in: 3600 });
    }
    // This handler is the only Worker egress path. Unexpected requests fail closed.
    assert.equal(url.hostname, 'fcm.googleapis.com', 'B1 blocked unexpected outbound host');
    assert.equal(url.pathname, '/v1/projects/b1-mock-project/messages:send');
    const { message } = await request.json();
    assert.equal(message.android.priority, 'HIGH');
    assert.equal(message.notification, undefined);
    assert.ok(Number(message.android.ttl.slice(0, -1)) > 0 && Number(message.android.ttl.slice(0, -1)) <= 120);
    assert.ok(message.token.startsWith('b1-synthetic-fcm-'));
    this.sent.push({ worker, token: message.token, data: message.data, ttl: message.android.ttl });
    return Response.json({ name: 'projects/b1-mock-project/messages/synthetic-' + this.sent.length });
  }
  async seed() {
    const t = this.now, db = this.db;
    for (const c of this.cases) {
      c.mobile = 'mobile-' + c.id;
      c.event = sha256('history-' + c.id);
      c.cipher = await protectToken(this.env, 'b1-synthetic-fcm-' + c.id);
      await db.batch([
        db.prepare(`INSERT INTO agents VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(c.id, '合成電腦 ' + c.id, 'MONITORING', 'READY', 'ALLOWED', 1, 'synthetic-windows-session', 'b1-legacy', t - 5000, t - 50000, t - 5000),
        db.prepare(`INSERT INTO alert_settings VALUES (?,?,?,?,?)`).bind(c.id, c.enabled, c.mode, c.expiry, t - 10000),
        db.prepare(`INSERT INTO android_devices VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(c.mobile, c.id, await digest(this.tokens.get(c.id)), 3, null, c.cipher, 7, 1, t - 40000, t - 10000),
        db.prepare(`INSERT INTO android_devices VALUES (?,?,?,?,?,?,?,?,?,?)`).bind('revoked-' + c.mobile, c.id, await digest('revoked-' + this.tokens.get(c.id)), 4, t - 45000, null, 2, 0, t - 90000, t - 45000),
        db.prepare(`INSERT INTO mobile_pairings VALUES (?,?,?,?,?,?,?,?)`).bind(await digest('claimed-code-' + c.id), c.id, t - 45000, t + 60000, t - 40000, c.mobile, 'synthetic-claim-' + c.id, 2),
        db.prepare(`INSERT INTO request_nonces VALUES (?,?,?)`).bind(c.id, 'synthetic-nonce-' + c.id, t + 60000),
        db.prepare(`INSERT INTO agent_status_transitions(device_id,status,observed_at_ms) VALUES (?,?,?)`).bind(c.id, 'MONITORING', t - 5000)
      ]);
      await db.prepare(`INSERT INTO alert_events VALUES (?,?,?,?,?,?,?,?,?)`).bind(c.id, c.event, 'TELEGRAM', 'Telegram.TelegramDesktop', '4294967295', t - 30000, t - 29000, 'ACCEPTED', 1).run();
      await db.prepare(`INSERT INTO alert_events VALUES (?,?,?,?,?,?,?,?,?)`).bind(c.id, sha256('stale-' + c.id), 'TELEGRAM', 'Telegram.TelegramDesktop', '2', t - 900000, t - 20000, 'STALE', 0).run();
      const state = c.id === 'b1-off' ? 'EXPIRED' : c.id === 'b1-always' ? 'SENT_TO_FCM' : c.id === 'b1-timed' ? 'PENDING' : 'RETRY';
      await db.prepare(`UPDATE push_jobs SET state=?,attempts=?,next_attempt_ms=?,last_error=?,sent_at_ms=? WHERE device_id=?`).bind(state, state === 'PENDING' ? 0 : 2, t, state === 'EXPIRED' ? 'DISABLED' : state === 'RETRY' ? 'FCM_NETWORK:FETCH_FAILED' : null, state === 'SENT_TO_FCM' ? t - 25000 : null, c.id).run();
      await db.prepare(`INSERT INTO mobile_acks VALUES (?,?,?,?)`).bind(c.mobile, c.event, 'RECEIVED', t - 28000).run();
    }
    const always = this.cases[1];
    for (const state of ['PENDING', 'RETRY']) await this.addJob(always, state);
    for (const status of ['RINGING', 'STOPPED', 'NOTIFICATION_FALLBACK']) {
      await db.prepare('INSERT INTO mobile_acks VALUES (?,?,?,?)').bind(always.mobile, always.event, status, t - 26000).run();
    }
    await db.prepare('INSERT INTO mobile_pairings VALUES (?,?,?,?,NULL,NULL,NULL,0)').bind(await digest('unclaimed-b1-code'), always.id, t - 1000, t + 60000).run();
    await db.prepare('INSERT INTO mobile_rate_limits VALUES (?,?,?)').bind('synthetic-global', t - t % 60000, 3).run();
    await db.prepare('INSERT INTO mobile_rate_limits VALUES (?,?,?)').bind('synthetic-source', t - t % 60000, 1).run();
  }
  async addJob(c, state = 'PENDING', monitoring) {
    const id = randomBytes(32).toString('hex');
    const columns = monitoring ? ',monitoring_session_id,monitoring_revision,occurred_at_ms' : '';
    const extra = monitoring ? ',?,?,?' : '';
    const values = [c.id, c.mobile, id, state, state === 'RETRY' ? 2 : 0, this.now, this.now + 120000, this.now,
      state === 'RETRY' ? 'FCM_NETWORK:FETCH_FAILED' : null];
    if (monitoring) values.push(monitoring.session_id, monitoring.revision, this.now);
    await this.db.prepare(`INSERT INTO push_jobs(device_id,mobile_id,event_id,push_type,state,attempts,created_at_ms,expires_at_ms,next_attempt_ms,last_error${columns}) VALUES (?,?,?,'WORK_ALERT',?,?,?,?,?,?${extra})`).bind(...values).run();
    return id;
  }
  async call(worker, c, route, method = 'GET', body, now = this.now, admin = false) {
    const fetcher = await this.mf.getWorker(worker);
    return fetcher.fetch('http://localhost' + route, { method, headers: {
      'Content-Type': 'application/json', 'X-B1-Control': this.bindings.B1_CONTROL, 'X-B1-Now': String(now),
      Authorization: 'Bearer ' + (admin ? this.bindings.ADMIN_API_KEY : this.tokens.get(c.id))
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  async alert(worker, c, occurred = this.now, eventId = randomBytes(32).toString('hex')) {
    const fetcher = await this.mf.getWorker(worker), stamp = String(Math.floor(this.now / 1000)), nonce = randomUUID().replaceAll('-', '');
    const body = JSON.stringify({ deviceId: c.id, eventId, source: 'TELEGRAM', aumid: 'Telegram.TelegramDesktop', notificationId: 42, occurredAt: new Date(occurred).toISOString() });
    const signature = createHmac('sha256', this.bindings.AGENT_HMAC_SECRET).update(['POST', '/api/alert', c.id, stamp, nonce, sha256(body)].join('\n')).digest('hex');
    const response = await fetcher.fetch('http://localhost/api/alert', { method: 'POST', body, headers: {
      'Content-Type': 'application/json', 'X-B1-Control': this.bindings.B1_CONTROL, 'X-B1-Now': String(this.now),
      'X-Device-Id': c.id, 'X-Timestamp': stamp, 'X-Nonce': nonce, 'X-Signature': 'v1=' + signature
    } });
    assert.ok([200, 202].includes(response.status), 'signed synthetic alert failed: ' + response.status);
    return { eventId, response };
  }
  async dispatch(worker) {
    const response = await this.call(worker, this.cases[0], '/__b1/dispatch', 'POST');
    assert.equal(response.status, 200, await response.text());
  }
  async jobs() { return (await this.db.prepare('SELECT * FROM push_jobs ORDER BY id').all()).results; }
  command(mode, expectedRevision, delayMinutes = mode === 'SCHEDULED' ? 1 : 0) {
    return { commandId: randomUUID(), expectedRevision, mode, delayMinutes, urgentConsent: mode !== 'OFF' };
  }
  async monitoring(c) { return (await (await this.call('current', c, '/api/mobile/monitoring')).json()).monitoring; }
  async put(c, command) { return this.call('current', c, '/api/mobile/monitoring', 'PUT', command); }
}
