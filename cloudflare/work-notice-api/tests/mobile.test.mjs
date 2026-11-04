import assert from 'node:assert/strict';
import test, { before, after, beforeEach } from 'node:test';
import { randomBytes, randomUUID, createHmac, createHash, generateKeyPairSync, verify } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { applyTestMigrations } from '../scripts/migrations.mjs';
import { dispatchPush, cleanupMobile, FcmSender } from '../.build/fcm.js';
import { protectToken, digest } from '../.build/mobile.js';
import { maintain } from '../.build/database.js';
import { PushFailure } from '../.build/push-errors.js';

const secret = randomBytes(32).toString('hex'), admin = randomBytes(32).toString('hex'), key = randomBytes(32).toString('hex');
let mf, db, env;
before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'mobile', modules: true, scriptPath: fileURLToPath(new URL('../.build/worker/index.js', import.meta.url)),
    compatibilityDate: '2026-11-02', d1Databases: ['DB'], bindings: { AGENT_HMAC_SECRET: secret, ADMIN_API_KEY: admin, ALLOWED_DEVICE_IDS: 'home-windows,other-windows', FCM_TOKEN_ENCRYPTION_KEY: key } }));
  db = await mf.getD1Database('DB'); await applyTestMigrations(db);
  env = { DB: db, FCM_TOKEN_ENCRYPTION_KEY: key, FCM_PROJECT_ID: 'mock-project', FCM_SERVICE_ACCOUNT_JSON: 'mocked-by-transport' };
});
after(async () => mf?.dispose());
beforeEach(async () => { for (const table of ['mobile_acks','push_jobs','android_devices','mobile_pairings','mobile_rate_limits','alert_events','alert_settings','agent_status_transitions','agents','request_nonces']) await db.prepare(`DELETE FROM ${table}`).run(); });
const request = (path, method = 'GET', body, token, ip = '127.0.0.1') => mf.dispatchFetch('http://localhost' + path, {
  method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), 'CF-Connecting-IP': ip }, ...(body ? { body: JSON.stringify(body) } : {}) });
const start = async () => (await (await request('/api/admin/pairing/start', 'POST', { deviceId: 'home-windows' }, admin)).json()).pairingCode;
const claim = (code, id = randomUUID()) => request('/api/mobile/pairing/claim', 'POST', { pairingCode: code, mobileId: id });
async function pair() { const code = await start(), r = await claim(code); assert.equal(r.status, 201); return (await r.json()).bearerToken; }
async function register() { const bearer = await pair(); assert.equal((await request('/api/mobile/fcm-token', 'POST', { token: 'fake-registration-token' }, bearer)).status, 200); return bearer; }
async function enable(bearer, extra = {}) { return request('/api/mobile/alert-settings', 'PUT', { enabled: true, mode: 'UNTIL_MANUALLY_DISABLED', ...extra }, bearer); }
async function sendAlert(event = randomBytes(32).toString('hex'), occurred = Date.now()) {
  const path = '/api/alert', timestamp = String(Math.floor(Date.now()/1000)), nonce = randomBytes(16).toString('hex');
  const body = JSON.stringify({ deviceId: 'home-windows', eventId: event, source: 'TELEGRAM', aumid: 'Telegram.TelegramDesktop', notificationId: 123, occurredAt: new Date(occurred).toISOString() });
  const signature = createHmac('sha256',secret).update(['POST',path,'home-windows',timestamp,nonce,createHash('sha256').update(body).digest('hex')].join('\n')).digest('hex');
  return mf.dispatchFetch('http://localhost' + path, { method:'POST', body, headers:{'Content-Type':'application/json','X-Device-Id':'home-windows','X-Timestamp':timestamp,'X-Nonce':nonce,'X-Signature':'v1='+signature} });
}
const count = async table => (await db.prepare(`SELECT count(*) n FROM ${table}`).first()).n;
async function due() { await db.prepare("UPDATE push_jobs SET next_attempt_ms=0,lease_until_ms=0 WHERE state IN ('PENDING','RETRY')").run(); }

test('pairing requires admin, stores only hash, and starts with future alerts disabled', async () => {
  assert.equal((await request('/api/admin/pairing/start','POST',{deviceId:'home-windows'})).status,401);
  const code=await start(); assert.equal(code.length,64);
  assert.equal((await db.prepare('SELECT code_hash FROM mobile_pairings').first()).code_hash,await digest(code));
  const response=await claim(code), result=await response.json(); assert.equal(response.status,201); assert.equal(result.bearerToken.length,64);
  assert.equal((await db.prepare('SELECT bearer_hash FROM android_devices').first()).bearer_hash,await digest(result.bearerToken));
  assert.equal((await (await request('/api/mobile/status','GET',null,result.bearerToken)).json()).alertSetting.effectiveEnabled,false);
});
test('expired and unknown pairing codes give same generic failure', async () => {
  const code=await start(); await db.prepare('UPDATE mobile_pairings SET expires_at_ms=0').run();
  assert.deepEqual(await (await claim(code)).json(),await (await claim('a'.repeat(64))).json());
});
test('atomic concurrent claim including same mobileId wins once; replay is rejected', async () => {
  const code=await start(), id=randomUUID();
  const responses=await Promise.all([claim(code,id),claim(code,id),claim(code)]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[201,400,400]); assert.equal(await count('android_devices'),1);
});
test('pairing attempts are rate limited durably per source and globally', async () => {
  for(let i=0;i<10;i++) assert.equal((await claim('b'.repeat(64))).status,400);
  assert.equal((await claim('b'.repeat(64))).status,429);
  await db.prepare('UPDATE mobile_rate_limits SET attempts=100 WHERE bucket=?').bind('global').run();
  assert.equal((await request('/api/mobile/pairing/claim','POST',{pairingCode:'b'.repeat(64),mobileId:randomUUID()},null,'different-source')).status,429);
});
test('bearer enforces scope, rejects malformed auth, queries and cross-device fields', async () => {
  const bearer=await pair(); assert.equal((await request('/api/mobile/status','GET',null,'c'.repeat(64))).status,401);
  assert.equal((await request('/api/mobile/status?deviceId=other-windows','GET',null,bearer)).status,400);
  assert.equal((await enable(bearer,{deviceId:'other-windows'})).status,400);
  assert.equal((await (await request('/api/mobile/status','GET',null,bearer)).json()).deviceId,'home-windows');
});
test('FCM registration rotates randomized authenticated ciphertext; no plaintext token', async () => {
  const bearer=await register(), first=await db.prepare('SELECT * FROM android_devices').first();
  assert.equal(await protectToken(env,first.fcm_cipher,true),'fake-registration-token'); assert.ok(!first.fcm_cipher.includes('fake-registration-token'));
  await request('/api/mobile/fcm-token','POST',{token:'replacement-token'},bearer);
  const second=await db.prepare('SELECT * FROM android_devices').first(); assert.notEqual(first.fcm_cipher,second.fcm_cipher); assert.equal(second.fcm_version,2);
  await assert.rejects(()=>protectToken({...env,FCM_TOKEN_ENCRYPTION_KEY:'0'.repeat(64)},second.fcm_cipher,true));
});
test('unpair revokes bearer and token; new pairing can replace revoked phone', async () => {
  const bearer=await register(); assert.equal((await request('/api/mobile/unpair','POST',{},bearer)).status,200);
  assert.equal((await request('/api/mobile/status','GET',null,bearer)).status,401); assert.equal((await db.prepare('SELECT fcm_cipher FROM android_devices').first()).fcm_cipher,null);
  assert.ok(await pair());
});
test('admin recovery revokes a lost phone without exposing its bearer', async () => {
  const bearer=await register(), oldCode=await start();
  assert.equal((await request('/api/admin/mobile/revoke','POST',{deviceId:'home-windows'})).status,401);
  assert.equal((await request('/api/admin/mobile/revoke','POST',{deviceId:'home-windows'},admin)).status,200);
  assert.equal((await request('/api/mobile/status','GET',null,bearer)).status,401); assert.equal((await claim(oldCode)).status,400); assert.ok(await pair());
});
test('150 minute expiry is server calculated; invalid duration rejected and offline toggle does not extend it', async () => {
  const bearer=await pair(), before=Date.now(); const response=await enable(bearer,{mode:'TIMED',durationMinutes:150}); const result=await response.json();
  assert.ok(result.expiresAtMs>=before+150*60000); assert.equal(result.expiresAtMs-result.serverNow,150*60000);
  assert.equal((await enable(bearer,{mode:'TIMED',durationMinutes:0})).status,400);
  assert.equal((await enable(bearer,{mode:'TIMED',durationMinutes:1441})).status,400);
  await request('/api/mobile/offline-settings','PUT',{offlineAlerts:false},bearer);
  assert.equal((await db.prepare('SELECT expires_at_ms FROM alert_settings').first()).expires_at_ms,result.expiresAtMs);
});
test('outbox only includes fresh enabled events; duplicate, disabled, expired and stale never enqueue', async () => {
  const bearer=await register(); await sendAlert(); assert.equal(await count('push_jobs'),0);
  await enable(bearer); const event=randomBytes(32).toString('hex'); await sendAlert(event); await sendAlert(event); await sendAlert(undefined,Date.now()-121000);
  await db.prepare('UPDATE alert_settings SET mode=?,expires_at_ms=0').bind('TIMED').run(); await sendAlert();
  assert.equal(await count('push_jobs'),1);
});
test('durable lease prevents concurrent dispatch; FCM accepted is distinct from device ACK', async () => {
  const bearer=await register(); await enable(bearer); await sendAlert(); await due(); let calls=0;
  const mock={send:async()=>{calls++; return 'SENT_TO_FCM';}};
  await Promise.all([dispatchPush(env,Date.now(),mock),dispatchPush(env,Date.now(),mock)]); assert.equal(calls,1);
  assert.equal((await db.prepare('SELECT state FROM push_jobs').first()).state,'SENT_TO_FCM'); assert.equal(await count('mobile_acks'),0);
});
test('missing FCM configuration does not break alert ingestion; records NOT_CONFIGURED', async () => {
  const bearer=await register(); await enable(bearer); assert.equal((await sendAlert()).status,202); await due();
  await dispatchPush({...env,FCM_SERVICE_ACCOUNT_JSON:undefined});
  assert.equal((await db.prepare('SELECT last_error FROM push_jobs').first()).last_error,'NOT_CONFIGURED');
});
test('transient errors persist retry; TTL and disabled settings terminate retries', async () => {
  const bearer=await register(); await enable(bearer); await sendAlert(); await due();
  await dispatchPush(env,Date.now(),{send:async()=> 'RETRY'});
  assert.equal((await db.prepare('SELECT state FROM push_jobs').first()).state,'RETRY');
  await dispatchPush(env,Date.now()+121000,{send:async()=>assert.fail('expired must not send')});
  assert.equal((await db.prepare('SELECT state FROM push_jobs').first()).state,'EXPIRED');
  await sendAlert(); await due(); await enable(bearer,{enabled:false}); await dispatchPush(env,Date.now(),{send:async()=>assert.fail('disabled must not send')});
  assert.equal((await db.prepare('SELECT state FROM push_jobs ORDER BY id DESC').first()).state,'EXPIRED');
});
test('TTL and attempt exhaustion preserve the originating OAuth/FCM diagnostic', async () => {
  const bearer=await register(); await enable(bearer); await sendAlert(); await due();
  const mock={send:async()=>{throw new PushFailure('OAUTH_HTTP','HTTP_ERROR',503,true);}};
  await dispatchPush(env,Date.now(),mock);
  assert.equal((await db.prepare('SELECT last_error FROM push_jobs').first()).last_error,'OAUTH_HTTP:503:HTTP_ERROR');
  await dispatchPush(env,Date.now()+121000,mock);
  assert.deepEqual(await db.prepare('SELECT state,last_error FROM push_jobs').first(),{state:'EXPIRED',last_error:'OAUTH_HTTP:503:HTTP_ERROR'});
  await sendAlert();
  for(let i=0;i<5;i++){await due();await dispatchPush(env,Date.now(),mock);}
  assert.deepEqual(await db.prepare('SELECT state,last_error FROM push_jobs ORDER BY id DESC LIMIT 1').first(),{state:'PERMANENT_FAILURE',last_error:'OAUTH_HTTP:503:HTTP_ERROR'});
});
test('TTL_EXPIRED is used when a job has no prior failure', async () => {
  const bearer=await register(); await enable(bearer); await sendAlert();
  await db.prepare('UPDATE push_jobs SET last_error=NULL').run();
  await dispatchPush(env,Date.now()+121000,{send:async()=>assert.fail('expired job must never send')});
  assert.deepEqual(await db.prepare('SELECT state,last_error FROM push_jobs').first(),{state:'EXPIRED',last_error:'TTL_EXPIRED'});
});
test('disable then re-enable never revives queued notifications', async () => {
  const bearer=await register(); await enable(bearer); await sendAlert(); await due();
  await dispatchPush(env,Date.now(),{send:async()=> 'RETRY'});
  await enable(bearer,{enabled:false}); await enable(bearer); await due();
  await dispatchPush(env,Date.now(),{send:async()=>assert.fail('disabled historical job must not replay')});
  assert.equal((await db.prepare('SELECT state FROM push_jobs').first()).state,'EXPIRED');
});
test('UNREGISTERED disables only failed token version and records permanent failure', async () => {
  const bearer=await register(); await enable(bearer); await sendAlert(); await due();
  await dispatchPush(env,Date.now(),{send:async()=> 'UNREGISTERED'});
  assert.equal((await db.prepare('SELECT fcm_cipher FROM android_devices').first()).fcm_cipher,null);
  assert.equal((await db.prepare('SELECT state,last_error FROM push_jobs').first()).last_error,'UNREGISTERED');
});
test('UNREGISTERED from an in-flight old token does not delete a newer registration', async () => {
  const bearer=await register(); await enable(bearer); await sendAlert(); await due();
  await dispatchPush(env,Date.now(),{send:async()=>{await request('/api/mobile/fcm-token','POST',{token:'newer-token'},bearer);return 'UNREGISTERED';}});
  assert.equal(await protectToken(env,(await db.prepare('SELECT fcm_cipher FROM android_devices').first()).fcm_cipher,true),'newer-token');
});
test('crashed dispatcher lease can recover; attempt budget is bounded', async () => {
  const bearer=await register(); await enable(bearer); await sendAlert(); await due();
  await db.prepare('UPDATE push_jobs SET lease_until_ms=?,lease_id=?').bind(Date.now()-1,'crashed-process').run();
  for(let i=0;i<5;i++){await due();await dispatchPush(env,Date.now(),{send:async()=> 'RETRY'});}
  const job=await db.prepare('SELECT state,attempts FROM push_jobs').first(); assert.equal(job.state,'PERMANENT_FAILURE'); assert.equal(job.attempts,5);
});
test('ACK is idempotent, scoped to paired phone jobs, and cannot invent events', async () => {
  const bearer=await register(); await enable(bearer); const event=randomBytes(32).toString('hex'); await sendAlert(event);
  for(let i=0;i<2;i++) assert.equal((await request('/api/mobile/ack','POST',{eventId:event,status:'STOPPED'},bearer)).status,200);
  assert.equal(await count('mobile_acks'),1); assert.equal((await request('/api/mobile/ack','POST',{eventId:'invented',status:'RINGING'},bearer)).status,404);
  assert.equal((await db.prepare('SELECT enabled FROM alert_settings').first()).enabled,1);
});
for (const mode of ['MONITORING','STANDBY']) {
  test(`${mode} unexpected loss enqueues one offline warning across concurrent/repeated Cron; recovery allows a distinct outage`, async () => {
    await register(); const now=Date.now();
    await db.prepare("INSERT INTO agents(device_id,reported_mode,listener_status,notification_permission,telegram_source_confirmed,last_seen_at_ms,created_at_ms,updated_at_ms) VALUES ('home-windows',?,'READY','ALLOWED',1,?,?,?)").bind(mode,now,now,now).run();
    await maintain(db,now); await maintain(db,now+180000);
    assert.equal(await count('push_jobs'),0); // A live standby agent is not offline.
    await Promise.all([maintain(db,now+180001),maintain(db,now+180001)]);
    await maintain(db,now+182000);
    const first = await db.prepare('SELECT event_id,push_type FROM push_jobs').first();
    assert.equal(await count('push_jobs'),1); assert.equal(first.push_type,'WINDOWS_OFFLINE');
    assert.equal((await db.prepare("SELECT count(*) n FROM agent_status_transitions WHERE status='OFFLINE'").first()).n,1);
    // The same transition's unique job cannot be inserted again, even by another producer.
    const duplicate = await db.prepare(`INSERT OR IGNORE INTO push_jobs(device_id,mobile_id,event_id,push_type,created_at_ms,expires_at_ms,next_attempt_ms)
      SELECT device_id,mobile_id,event_id,push_type,created_at_ms,expires_at_ms,next_attempt_ms FROM push_jobs`).run();
    assert.equal(duplicate.meta.changes,0); assert.equal(await count('push_jobs'),1);
    await db.prepare("UPDATE agents SET last_seen_at_ms=? WHERE device_id='home-windows'").bind(now+183000).run();
    await maintain(db,now+183000); assert.equal(await count('push_jobs'),1);
    await maintain(db,now+363001);
    const jobs = (await db.prepare('SELECT event_id,push_type FROM push_jobs ORDER BY id').all()).results;
    assert.equal(jobs.length,2); assert.notEqual(jobs[0].event_id,jobs[1].event_id);
    assert.ok(jobs.every(job=>job.push_type==='WINDOWS_OFFLINE')); // No looping WORK_ALERT.
  });
  test(`${mode} offline warning obeys mobile offline_alerts without backfilling a muted outage`, async () => {
    const bearer=await register(), now=Date.now();
    await request('/api/mobile/offline-settings','PUT',{offlineAlerts:false},bearer);
    await db.prepare("INSERT INTO agents(device_id,reported_mode,last_seen_at_ms,created_at_ms,updated_at_ms) VALUES ('home-windows',?,?,?,?)").bind(mode,now-181000,now,now).run();
    await maintain(db,now); assert.equal(await count('push_jobs'),0);
    await request('/api/mobile/offline-settings','PUT',{offlineAlerts:true},bearer);
    await maintain(db,now+1000); assert.equal(await count('push_jobs'),0);
    await db.prepare("UPDATE agents SET last_seen_at_ms=? WHERE device_id='home-windows'").bind(now+2000).run();
    await maintain(db,now+2000); await maintain(db,now+182001);
    assert.equal(await count('push_jobs'),1);
  });
}
test('STOPPED_BY_USER never produces an abnormal offline warning even after heartbeat expiry', async () => {
  await register(); const now=Date.now();
  await db.prepare("INSERT INTO agents(device_id,reported_mode,last_seen_at_ms,created_at_ms,updated_at_ms) VALUES ('home-windows','STOPPED_BY_USER',?,?,?)").bind(now-181000,now,now).run();
  await maintain(db,now); await maintain(db,now+86400000);
  assert.equal(await count('push_jobs'),0);
  assert.deepEqual((await db.prepare('SELECT status FROM agent_status_transitions').all()).results,[{status:'STOPPED_BY_USER'}]);
  // Defense in depth: an inconsistent OFFLINE row must not bypass the running-mode guard.
  await db.prepare("INSERT INTO agent_status_transitions(device_id,status,observed_at_ms) VALUES ('home-windows','OFFLINE',?)").bind(now+86400001).run();
  assert.equal(await count('push_jobs'),0);
});
test('Cron cleans expired pairings/rate limits/jobs/ACKs with seven day delivery retention', async () => {
  const bearer=await register(); await enable(bearer); await sendAlert(); const now=Date.now()+8*86400000;
  await cleanupMobile(db,now); assert.equal(await count('mobile_pairings'),0); assert.equal(await count('mobile_rate_limits'),0); assert.equal(await count('push_jobs'),0);
});

const keys=generateKeyPairSync('rsa',{modulusLength:2048});
const oauthEnv={FCM_PROJECT_ID:'mock-project',FCM_SERVICE_ACCOUNT_JSON:JSON.stringify({type:'service_account',project_id:'mock-project',client_email:'test@mock.iam.gserviceaccount.com',private_key:keys.privateKey.export({type:'pkcs8',format:'pem'})})};
test('mock OAuth signs valid scoped JWT, caches tokens, refreshes expiry and refreshes FCM 401 only once', async () => {
  let oauth=0, sends=0, rejectOnce=false;
  const transport=async(url,init)=>{
    if(url.includes('oauth2')) {
      oauth++; const jwt=new URLSearchParams(init.body).get('assertion'), [a,b,s]=jwt.split('.'); const payload=JSON.parse(Buffer.from(b,'base64url'));
      assert.equal(payload.scope,'https://www.googleapis.com/auth/firebase.messaging'); assert.ok(verify('RSA-SHA256',Buffer.from(a+'.'+b),keys.publicKey,Buffer.from(s,'base64url')));
      return Response.json({access_token:'mock-oauth-'+oauth,expires_in:3600});
    }
    sends++; const message=JSON.parse(init.body).message; assert.equal(message.android.priority,'HIGH'); assert.equal(message.android.collapse_key,undefined); assert.equal(message.notification,undefined);
    if(rejectOnce){rejectOnce=false;return Response.json({}, {status:401});} return Response.json({name:'mock-only'});
  };
  const client=new FcmSender(transport), now=Date.now();
  await client.send(oauthEnv,'mock',{},120,now); await client.send(oauthEnv,'mock',{},120,now+1000); assert.equal(oauth,1);
  await client.send(oauthEnv,'mock',{},120,now+3600000); assert.equal(oauth,2);
  rejectOnce=true; await client.send(oauthEnv,'mock',{},120,now+3601000); assert.equal(oauth,3); assert.equal(sends,5);
});
test('mock FCM bounds 401 refresh, handles 403/429/5xx/UNREGISTERED without real network', async () => {
  for(const [status,expected] of [[401,'PERMANENT_FAILURE'],[403,'PERMANENT_FAILURE'],[429,'RETRY'],[500,'RETRY'],[404,'UNREGISTERED']]) {
    let sends=0;
    const client=new FcmSender(async url=>url.includes('oauth2')?Response.json({access_token:'mock',expires_in:3600}):(++sends,Response.json({error:{details:[{errorCode:status===404?'UNREGISTERED':'OTHER'}]}},{status})));
    assert.equal(await client.send(oauthEnv,'mock',{},120,Date.now()),expected); assert.equal(sends,status===401?2:1);
  }
});
