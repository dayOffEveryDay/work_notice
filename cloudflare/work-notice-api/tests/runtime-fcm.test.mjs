import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID, generateKeyPairSync, createHash, createHmac, verify } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { applyTestMigrations } from '../scripts/migrations.mjs';

test('actual workerd reproduces the original native-fetch receiver failure before any outbound request',async()=>{
  let outbound=0;
  const mf=new Miniflare(convertV4MiniflareOptions({name:'receiver-probe',modules:true,compatibilityDate:'2026-11-02',
    script:`export default { async fetch() { const sender={transport:fetch}; try { await sender.transport('https://oauth2.googleapis.com/token'); return Response.json({failed:false}); } catch(error) { return Response.json({failed:error instanceof TypeError,illegalInvocation:error.message.includes('Illegal invocation')}); } } }`,
    outboundService:async()=>{outbound++;return new Response('intercepted');}
  }));
  try {assert.deepEqual(await(await mf.dispatchFetch('http://localhost/probe')).json(),{failed:true,illegalInvocation:true});assert.equal(outbound,0);}
  finally {await mf.dispose();}
});
test('actual workerd rejects redirect:error before network, requiring manual redirect handling',async()=>{
  let outbound=0;
  const mf=new Miniflare(convertV4MiniflareOptions({name:'redirect-probe',modules:true,compatibilityDate:'2026-11-02',
    script:`export default { async fetch() { try { await globalThis.fetch('https://oauth2.googleapis.com/token',{redirect:'error'}); return Response.json({failed:false}); } catch(error) { return Response.json({failed:error instanceof TypeError,invalidRedirect:error.message.includes('Invalid redirect value')}); } } }`,
    outboundService:async()=>{outbound++;return new Response('intercepted');}
  }));
  try {assert.deepEqual(await(await mf.dispatchFetch('http://localhost/probe')).json(),{failed:true,invalidRedirect:true});assert.equal(outbound,0);}
  finally {await mf.dispose();}
});

async function fixture(oauthFailure=false) {
  const keys=generateKeyPairSync('rsa',{modulusLength:2048}), secret=randomBytes(32).toString('hex'),admin=randomBytes(32).toString('hex');
  const counts={oauth:0,fcm:0}; let mockPhase='NOT_CALLED';
  const mf=new Miniflare(convertV4MiniflareOptions({name:'production-fcm-local',modules:true,compatibilityDate:'2026-11-02',
    scriptPath:fileURLToPath(new URL('../.build/worker/index.js',import.meta.url)),d1Databases:['DB'],
    bindings:{AGENT_HMAC_SECRET:secret,ADMIN_API_KEY:admin,ALLOWED_DEVICE_IDS:'home-windows',ALLOWED_LARK_A_CHROME_AUMIDS:'synthetic.chrome.lark',ALLOWED_LARK_B_BRAVE_AUMIDS:'synthetic.brave.lark',FCM_TOKEN_ENCRYPTION_KEY:randomBytes(32).toString('hex'),FCM_PROJECT_ID:'mock-project',
      FCM_SERVICE_ACCOUNT_JSON:JSON.stringify({type:'service_account',project_id:'mock-project',client_email:'test@mock.iam.gserviceaccount.com',private_key:keys.privateKey.export({type:'pkcs8',format:'pem'})})},
    // No Google network: intercept native workerd fetch, not a Node-injected FcmSender mock.
    outboundService:async request=>{
      mockPhase='URL';
      const url=new URL(request.url);
      if(url.hostname==='oauth2.googleapis.com' && url.pathname==='/token') {
        counts.oauth++; mockPhase='OAUTH_CONTENT_TYPE'; assert.equal(request.headers.get('Content-Type'),'application/x-www-form-urlencoded');
        const form=new URLSearchParams(await request.text()),jwt=form.get('assertion');assert.ok(jwt);
        mockPhase='JWT'; const [a,b,s]=jwt.split('.'),header=JSON.parse(Buffer.from(a,'base64url')),payload=JSON.parse(Buffer.from(b,'base64url'));
        assert.equal(header.alg,'RS256');assert.equal(payload.scope,'https://www.googleapis.com/auth/firebase.messaging');
        assert.equal(payload.aud,'https://oauth2.googleapis.com/token');assert.equal(payload.exp-payload.iat,3600);
        assert.ok(verify('RSA-SHA256',Buffer.from(a+'.'+b),keys.publicKey,Buffer.from(s,'base64url')));
        mockPhase='OAUTH_RESPONSE'; if(oauthFailure)return Response.json({error:'invalid_grant',error_description:'PRIVATE-CANARY-NEVER-LOG'},{status:400});
        return Response.json({access_token:'local-mock-access',expires_in:3600});
      }
      mockPhase='FCM_URL'; assert.equal(url.hostname,'fcm.googleapis.com');assert.equal(url.pathname,'/v1/projects/mock-project/messages:send');
      counts.fcm++; assert.ok(request.headers.get('Authorization')?.startsWith('Bearer '));
      const {message}=await request.json();assert.equal(message.android.priority,'HIGH');assert.equal(message.data.type,'WORK_ALERT');
      assert.equal(message.notification,undefined);assert.ok(Number(message.android.ttl.slice(0,-1))<=120);
      return Response.json({name:'projects/mock-project/messages/local-only'});
    }
  }));
  const db=await mf.getD1Database('DB');await applyTestMigrations(db);
  const call=(path,method,body,token)=>mf.dispatchFetch('http://localhost'+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
  const start=await call('/api/admin/pairing/start','POST',{deviceId:'home-windows'},admin);assert.equal(start.status,201);
  const claim=await call('/api/mobile/pairing/claim','POST',{pairingCode:(await start.json()).pairingCode,mobileId:randomUUID()});assert.equal(claim.status,201);
  const bearer=(await claim.json()).bearerToken;
  assert.equal((await call('/api/mobile/fcm-token','POST',{token:'local-mock-registration'},bearer)).status,200);
  assert.equal((await call('/api/mobile/alert-settings','PUT',{enabled:true,mode:'UNTIL_MANUALLY_DISABLED'},bearer)).status,200);
  const alert=async(source='TELEGRAM',aumid='Telegram.TelegramDesktop')=>{
    const body=JSON.stringify({deviceId:'home-windows',eventId:randomBytes(32).toString('hex'),source,aumid,notificationId:1,occurredAt:new Date().toISOString()});
    const timestamp=String(Math.floor(Date.now()/1000)),nonce=randomUUID().replaceAll('-','');
    const signature=createHmac('sha256',secret).update(['POST','/api/alert','home-windows',timestamp,nonce,createHash('sha256').update(body).digest('hex')].join('\n')).digest('hex');
    assert.equal((await mf.dispatchFetch('http://localhost/api/alert',{method:'POST',body,headers:{'Content-Type':'application/json','X-Device-Id':'home-windows','X-Timestamp':timestamp,'X-Nonce':nonce,'X-Signature':'v1='+signature}})).status,202);
    for(let i=0;i<100;i++){
      const job=await db.prepare('SELECT state,last_error,sent_at_ms FROM push_jobs ORDER BY id DESC LIMIT 1').first();
      if(job && !['PENDING','RETRY'].includes(job.state))return job;
      await delay(25);
    }
    assert.fail('Immediate dispatch did not finish in local workerd: '+JSON.stringify({counts,mockPhase}));
  };
  return {mf,db,counts,alert,call,bearer};
}
test('actual workerd production pairing -> D1 outbox -> native fetch -> mocked OAuth/FCM succeeds and caches token',async()=>{
  const f=await fixture();
  try {
    for(let i=0;i<2;i++){const job=await f.alert();assert.equal(job.state,'SENT_TO_FCM');assert.equal(job.last_error,null);assert.ok(job.sent_at_ms>0);}
    assert.deepEqual(f.counts,{oauth:1,fcm:2});assert.equal((await f.db.prepare('SELECT count(*) n FROM alert_events').first()).n,2);
  } finally {await f.mf.dispose();}
});
test('three legal sources share actual workerd pairing, monitoring, encrypted token and mocked native OAuth/FCM',async()=>{
  const f=await fixture();
  try {
    const command=await f.call('/api/mobile/monitoring','PUT',{commandId:randomUUID(),expectedRevision:0,mode:'IMMEDIATE',delayMinutes:0,urgentConsent:true},f.bearer);
    assert.equal(command.status,200);
    for(const [source,aumid] of [['TELEGRAM','Telegram.TelegramDesktop'],['LARK_A_CHROME','synthetic.chrome.lark'],['LARK_B_BRAVE','synthetic.brave.lark']]){
      const job=await f.alert(source,aumid);assert.equal(job.state,'SENT_TO_FCM');
    }
    assert.deepEqual(f.counts,{oauth:1,fcm:3});
    const rows=(await f.db.prepare('SELECT source FROM alert_events').all()).results;
    assert.equal(new Set(rows.map(r=>r.source)).size,3);
  } finally {await f.mf.dispose();}
});

test('actual workerd persists safe OAuth HTTP details without sending FCM or exposing Google description',async()=>{
  const f=await fixture(true);
  try {const job=await f.alert();assert.equal(job.state,'PERMANENT_FAILURE');assert.equal(job.last_error,'OAUTH_HTTP:400:INVALID_GRANT');assert.equal(job.sent_at_ms,null);assert.deepEqual(f.counts,{oauth:1,fcm:0});}
  finally {await f.mf.dispose();}
});
