import assert from 'node:assert/strict';
import { randomBytes, randomUUID, generateKeyPairSync, verify } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { readFile, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const project = fileURLToPath(new URL('../../../tests/WorkNoticeAgent.IntegrationProbe/WorkNoticeAgent.IntegrationProbe.csproj', import.meta.url));
const portable = fileURLToPath(new URL('../../../.tools/dotnet/dotnet.exe', import.meta.url));
let dotnet = 'dotnet';
try { await access(portable); dotnet = portable; } catch { }
const secret = randomBytes(32).toString('hex'), admin = randomBytes(32).toString('hex');
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const counts = { oauth: 0, fcm: 0 };
const payloads = [];
const mf = new Miniflare(convertV4MiniflareOptions({ name: 'api', modules: true,
  scriptPath: fileURLToPath(new URL('../.build/worker/index.js', import.meta.url)), compatibilityDate: '2026-11-02', d1Databases: ['DB'],
  bindings: { AGENT_HMAC_SECRET: secret, ADMIN_API_KEY: admin, FCM_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex'), FCM_PROJECT_ID: 'mock-project', FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({type:'service_account',project_id:'mock-project',client_email:'local@mock.iam.gserviceaccount.com',private_key:keys.privateKey.export({type:'pkcs8',format:'pem'})}), ALLOWED_DEVICE_IDS: 'home-windows', ALLOWED_LARK_A_CHROME_AUMIDS: 'synthetic.chrome.lark', ALLOWED_LARK_B_BRAVE_AUMIDS: 'synthetic.brave.lark' },
  outboundService: async request => {
    const url = new URL(request.url);
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') {
      counts.oauth++;
      const [a,b,s] = new URLSearchParams(await request.text()).get('assertion').split('.');
      assert.ok(verify('RSA-SHA256', Buffer.from(a+'.'+b), keys.publicKey, Buffer.from(s,'base64url')));
      return Response.json({access_token:'synthetic-local-access',expires_in:3600});
    }
    assert.equal(url.hostname, 'fcm.googleapis.com');
    assert.equal(url.pathname, '/v1/projects/mock-project/messages:send');
    const {message} = await request.json();
    assert.equal(message.token, 'synthetic-local-registration');
    assert.equal(message.data.type, 'WORK_ALERT');
    assert.equal(message.data.monitoringRevision, '1');
    assert.equal(message.notification, undefined);
    assert.equal(message.android.priority, 'HIGH');
    payloads.push(message.data); counts.fcm++;
    return Response.json({name:'projects/mock-project/messages/local-'+counts.fcm});
  }
}));
try {
  const db = await mf.getD1Database('DB');
  await (await import('./migrations.mjs')).applyTestMigrations(db);
  
  const call = (path, body, token, method = 'POST') => mf.dispatchFetch('http://localhost'+path, {
    method, headers: {'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{})}, body:JSON.stringify(body) });
  const pairing = await call('/api/admin/pairing/start', {deviceId:'home-windows'}, admin);
  assert.equal(pairing.status,201);
  const claim = await call('/api/mobile/pairing/claim', {pairingCode:(await pairing.json()).pairingCode,mobileId:randomUUID()});
  assert.equal(claim.status,201);
  const bearer = (await claim.json()).bearerToken;
  assert.equal((await call('/api/mobile/fcm-token', {token:'synthetic-local-registration'}, bearer)).status,200);
  assert.equal((await call('/api/mobile/monitoring', {commandId:randomUUID(),expectedRevision:0,mode:'IMMEDIATE',delayMinutes:0,urgentConsent:true}, bearer, 'PUT')).status,200);
  const environment = { ...process.env, WORK_NOTICE_TEST_SECRET: secret, WORK_NOTICE_TEST_ENDPOINT: String(await mf.ready),
    DOTNET_CLI_HOME: root + '/.tools/cli-home', NUGET_PACKAGES: root + '/.tools/nuget', DOTNET_CLI_TELEMETRY_OPTOUT: '1' };
  const options = { cwd: root, env: environment, windowsHide: true, timeout: 60000, maxBuffer: 2 * 1024 * 1024 };
  await run(dotnet, ['restore', project, '--configfile', root + '/NuGet.Config'], options);
  const result = await run(dotnet, ['run', '--project', project, '--no-restore', '-p:UseSharedCompilation=false'], options);
  console.log(result.stdout.trim());
  const events = await db.prepare('SELECT * FROM alert_events').all();
  assert.equal(events.results.length, 3);
  assert.deepEqual(events.results.map(e => e.source).sort(), ['TELEGRAM','LARK_A_CHROME','LARK_B_BRAVE'].sort());
  assert.equal(new Set(events.results.map(e => e.event_id)).size, 3);
  assert.equal(events.results[0].event_id.length, 64);
  assert.equal(events.results[0].result, 'ACCEPTED');
  const agent = await db.prepare('SELECT reported_mode,notification_permission,telegram_source_confirmed FROM agents WHERE device_id=?').bind('home-windows').first();
  assert.equal(agent.reported_mode, 'STOPPED_BY_USER');
  assert.equal(agent.notification_permission, 'ALLOWED');
  assert.equal(agent.telegram_source_confirmed, 1);
  for (let i=0; i<100 && counts.fcm<3; i++) await wait(25);
  assert.equal(counts.fcm,3);
  assert.equal(new Set(payloads.map(p=>p.eventId)).size,3);
  const jobs = (await db.prepare('SELECT * FROM push_jobs').all()).results;
  assert.equal(jobs.length,3);
  assert.ok(jobs.every(j=>j.state==='SENT_TO_FCM' && j.monitoring_revision===1));
  console.log('PASS: actual production C# -> signed HTTP -> local workerd/D1 -> native OAuth/FCM mock: 3 pushes, no replay after 6 attempts.');
  console.log('PASS: actual local D1 contains exactly three distinct source alerts after six C# HTTP attempts; authenticated heartbeat and normal stop persisted.');
} finally { await mf.dispose(); }
