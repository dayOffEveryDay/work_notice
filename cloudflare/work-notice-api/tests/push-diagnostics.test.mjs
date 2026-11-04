import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, verify } from 'node:crypto';
import { FcmSender } from '../.build/fcm.js';
import { PushFailure, fcmCode, oauthCode, logPushFailure, logDispatchFailure } from '../.build/push-errors.js';
const keys = generateKeyPairSync('rsa', { modulusLength:2048 });
const account = { type:'service_account',project_id:'mock-project',client_email:'local@mock.iam.gserviceaccount.com',private_key:keys.privateKey.export({type:'pkcs8',format:'pem'}) };
const env = sa => ({ FCM_PROJECT_ID:'mock-project', FCM_SERVICE_ACCOUNT_JSON:JSON.stringify(sa) });
const canary = 'PRIVATE-CANARY-DO-NOT-LOG';
const send = (client, config=env(account), report) => client.send(config,canary,{type:'WORK_ALERT'},120,Date.now(),report);
const failure = (stage,code,status=null,retryable=false) => error => {
  assert.ok(error instanceof PushFailure); assert.equal(error.stage,stage); assert.equal(error.code,code); assert.equal(error.httpStatus,status); assert.equal(error.retryable,retryable);
  assert.ok(!error.message.includes(canary)); return true;
};
for (const [label,sa,stage,code] of [
  ['fields',{},'SERVICE_ACCOUNT','INVALID_FIELDS'],
  ['project',{...account,project_id:'different'},'SERVICE_ACCOUNT','PROJECT_MISMATCH'],
  ['PKCS8',{...account,private_key:canary},'JWT_IMPORT','INVALID_PKCS8_KEY']
]) test(`service-account ${label} errors are classified before network without secrets`, async()=>{
  await assert.rejects(()=>send(new FcmSender(async()=>assert.fail('network must not run')),env(sa)),failure(stage,code));
});
test('invalid JSON is classified without echoing supplied text',async()=>{
  await assert.rejects(()=>send(new FcmSender(async()=>assert.fail()),{FCM_PROJECT_ID:'mock-project',FCM_SERVICE_ACCOUNT_JSON:canary}),failure('SERVICE_ACCOUNT','INVALID_JSON'));
});
test('BOM JSON and escaped PEM newlines work; OAuth uses explicit form encoding with valid RS256 JWT',async()=>{
  let calls=0;
  const client=new FcmSender(async(url,init)=>{
    calls++;
    if(url.includes('oauth2')) {
      assert.equal(init.headers['Content-Type'],'application/x-www-form-urlencoded'); assert.equal(typeof init.body,'string');
      const form=new URLSearchParams(init.body); assert.equal(form.get('grant_type'),'urn:ietf:params:oauth:grant-type:jwt-bearer');
      const [a,b,s]=form.get('assertion').split('.');
      assert.ok(verify('RSA-SHA256',Buffer.from(a+'.'+b),keys.publicKey,Buffer.from(s,'base64url')));
      return Response.json({access_token:canary,expires_in:3600});
    }
    return Response.json({name:'projects/mock-project/messages/local-only'});
  });
  assert.equal(await send(client,{FCM_PROJECT_ID:'mock-project',FCM_SERVICE_ACCOUNT_JSON:'\uFEFF'+JSON.stringify({...account,private_key:account.private_key.replaceAll('\n','\\n')})}),'SENT_TO_FCM'); assert.equal(calls,2);
});
test('OAuth invalid_grant retains stage/status/code and never error_description',async()=>{
  const client=new FcmSender(async()=>Response.json({error:'invalid_grant',error_description:canary},{status:400}));
  await assert.rejects(()=>send(client),failure('OAUTH_HTTP','INVALID_GRANT',400));
});
test('OAuth throttling is retryable and unrecognized upstream codes are discarded',async()=>{
  const client=new FcmSender(async()=>Response.json({error:canary,error_description:canary},{status:429}));
  await assert.rejects(()=>send(client),failure('OAUTH_HTTP','HTTP_ERROR',429,true));
});
test('malformed successful OAuth response cannot masquerade as authenticated',async()=>{
  for(const response of [()=>new Response(canary),()=>Response.json({access_token:canary,expires_in:0})])
    await assert.rejects(()=>send(new FcmSender(async()=>response())),failure('OAUTH_RESPONSE','INVALID_TOKEN_RESPONSE',200,true));
});
test('OAuth timeout/receiver/network errors have fixed non-sensitive codes',async()=>{
  for(const [error,code] of [[new DOMException(canary,'TimeoutError'),'TIMEOUT'],[new TypeError('Illegal invocation '+canary),'ILLEGAL_INVOCATION'],[new TypeError(canary),'FETCH_FAILED']])
    await assert.rejects(()=>send(new FcmSender(async()=>{throw error;})),failure('OAUTH_NETWORK',code,null,true));
});
test('FCM network failure is distinct from OAuth and excludes raw errors',async()=>{
  const client=new FcmSender(async url=>{if(url.includes('oauth2'))return Response.json({access_token:canary,expires_in:3600});throw new Error(canary);});
  await assert.rejects(()=>send(client),failure('FCM_NETWORK','FETCH_FAILED',null,true));
});
for(const stage of ['OAUTH','FCM']) test(`${stage} redirect is not followed and cannot forward credentials`,async()=>{
  let calls=0,detail;
  const client=new FcmSender(async(url,init)=>{
    calls++; assert.equal(init.redirect,'manual');
    if(stage==='FCM' && url.includes('oauth2'))return Response.json({access_token:canary,expires_in:3600});
    return new Response(null,{status:302,headers:{Location:'https://redirect.invalid/'+canary}});
  });
  if(stage==='OAUTH')await assert.rejects(()=>send(client),failure('OAUTH_HTTP','HTTP_ERROR',302));
  else {assert.equal(await send(client,env(account),value=>{detail=value;}),'PERMANENT_FAILURE');assert.ok(failure('FCM_HTTP','HTTP_ERROR',302)(detail));}
  assert.equal(calls,stage==='OAUTH'?1:2);
});
test('FCM HTTP diagnostic preserves allowlisted detail and status, without message or arbitrary fields',async()=>{
  let detail;
  const client=new FcmSender(async url=>url.includes('oauth2')?Response.json({access_token:canary,expires_in:3600}):Response.json({error:{message:canary,status:'PERMISSION_DENIED',details:[{errorCode:'SENDER_ID_MISMATCH',token:canary}]}},{status:403}));
  assert.equal(await send(client,env(account),value=>{detail=value;}),'PERMANENT_FAILURE');
  assert.ok(failure('FCM_HTTP','SENDER_ID_MISMATCH',403)(detail));
});
test('malformed FCM 200 is diagnosed rather than recorded as SENT_TO_FCM',async()=>{
  const client=new FcmSender(async url=>url.includes('oauth2')?Response.json({access_token:canary,expires_in:3600}):new Response(canary));
  await assert.rejects(()=>send(client),failure('FCM_RESPONSE','INVALID_SEND_RESPONSE',200,true));
});
test('untrusted upstream codes and structured logs cannot leak payloads, headers or credentials',()=>{
  assert.equal(oauthCode({error:canary}),'HTTP_ERROR'); assert.equal(fcmCode({error:{status:canary,details:[{errorCode:canary}]}}),'HTTP_ERROR');
  assert.equal(fcmCode({error:{details:canary}}),'HTTP_ERROR');
  const logs=[],warn=console.warn,error=console.error;
  try {console.warn=line=>logs.push(line);console.error=line=>logs.push(line);logPushFailure(new PushFailure('OAUTH_HTTP','INVALID_GRANT',400,false),7,1,'PERMANENT_FAILURE');logDispatchFailure();}
  finally {console.warn=warn;console.error=error;}
  assert.deepEqual(Object.keys(JSON.parse(logs[0])),['event','jobId','attempt','state','stage','httpStatus','code','retryable']);
  assert.ok(!logs.join('').includes(canary)); assert.ok(!logs.join('').match(/Authorization|Bearer|private_key|access_token|assertion/));
});
