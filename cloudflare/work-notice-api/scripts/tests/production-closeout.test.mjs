import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { acceptReviewedBackup,currentMetadataCheck,closeoutAllowed } from '../production-closeout.mjs';
import { metadataSql,tables } from '../production-backup.mjs';

// Synthetic responses only; tests never invoke the remote command runner.
const b=JSON.parse(await readFile(new URL('../production-backup-baseline.json',import.meta.url),'utf8'));
const review=JSON.parse(await readFile(new URL('../production-closeout-review.json',import.meta.url),'utf8'));
const verified=()=>({sqlSha256:review.sqlSha256,restoreValidation:{status:'PASS'},originalStageStatus:'STOPPED',missingEvidence:[],
  preflightVsExport:{schemaEqual:true,ledgerEqual:true,counts:structuredClone(review.acceptedBackupWindowDrift)}});
const metadata=()=>({ledger:structuredClone(b.migrations),schema:[...tables,'d1_migrations'].map(name=>({type:'table',name,tbl_name:name,sql:'SYNTHETIC CREATE '+name})),
  counts:Object.fromEntries(tables.map(t=>[t,10]))});

test('only original reviewed nonce 5->6 is accepted, with immutable STOPPED manifest',()=>{
  const v=verified(),before=JSON.stringify(v);assert.equal(acceptReviewedBackup(v,review).status,'REVIEWED_AND_ACCEPTED');assert.equal(JSON.stringify(v),before);
});
for(const kind of ['another-table','different-nonce-count','schema','ledger','restore','missing-evidence','sql-hash','manifest'])test('unknown historical '+kind+' difference blocks closeout',()=>{
  const v=verified();
  if(kind==='another-table')v.preflightVsExport.counts.push({table:'push_jobs',expected:1,actual:2});
  if(kind==='different-nonce-count')v.preflightVsExport.counts[0].actual=7;
  if(kind==='schema')v.preflightVsExport.schemaEqual=false;
  if(kind==='ledger')v.preflightVsExport.ledgerEqual=false;
  if(kind==='restore')v.restoreValidation.status='FAIL';
  if(kind==='missing-evidence')v.missingEvidence.push('unknown');
  if(kind==='sql-hash')v.sqlSha256='wrong';
  if(kind==='manifest')v.originalStageStatus='PASS';
  assert.throws(()=>acceptReviewedBackup(v,review),/mismatch/);
});
test('newer live event/ACK/nonces counts are all recorded, not treated as restore failures',()=>{
  const old=metadata(),now=structuredClone(old);now.counts.alert_events+=4;now.counts.mobile_acks+=3;now.counts.request_nonces-=2;
  const r=currentMetadataCheck(b,old,now);assert.equal(r.schema,'PASS');assert.equal(r.ledger,'PASS');
  assert.deepEqual(r.liveCountObservations.map(x=>x.table).sort(),['alert_events','mobile_acks','request_nonces']);
  assert.equal(r.liveCountObservations.find(x=>x.table==='request_nonces').delta,-2);
});
test('new or modified schema never passes as live count activity and exposes no SQL text',()=>{
  const old=metadata(),now=structuredClone(old);now.schema[0].sql='PRIVATE-SQL-CANARY';
  assert.throws(()=>currentMetadataCheck(b,old,now),e=>e.safeDifference.schema.changed.length===1&&!JSON.stringify(e.safeDifference).includes('PRIVATE-SQL-CANARY'));
});
test('migration 0003 already applied blocks closeout',()=>{
  const old=metadata(),now=structuredClone(old);now.ledger.push({id:3,name:'0003_scheduled_activation.sql',applied_at:'synthetic'});
  assert.throws(()=>currentMetadataCheck(b,old,now),/Current applied migrations/);
});
test('unknown identity/configuration counts block with safe table/count details',()=>{
  const old=metadata(),now=structuredClone(old);now.counts.android_devices++;
  assert.throws(()=>currentMetadataCheck(b,old,now),e=>e.safeDifference.counts[0].table==='android_devices');
});
test('non-pruned transition history loss is not silently ignored',()=>{
  const old=metadata(),now=structuredClone(old);now.counts.agent_status_transitions--;
  assert.throws(()=>currentMetadataCheck(b,old,now),/history count changed/);
});
test('closeout allowlist is read-only and excludes even SQL export and local imports',()=>{
  for(const args of [
    ['whoami','--json'],['deployments','list','--name',b.worker,'--json'],
    ['versions','view',b.versionId,'--name',b.worker,'--json'],['d1','info',b.databaseName,'--json'],
    ['d1','execute',b.databaseName,'--remote','--command',metadataSql,'--json'],['d1','time-travel','info',b.databaseName,'--json']
  ])assert.equal(closeoutAllowed(args,b),true);
  for(const args of [
    ['deploy'],['deploy','--dry-run'],['d1','export',b.databaseName,'--remote','--output','backup.sql'],
    ['d1','migrations','apply',b.databaseName,'--remote'],['d1','time-travel','restore',b.databaseName,'--bookmark','fake'],
    ['d1','execute',b.databaseName,'--remote','--command','UPDATE agents SET reported_mode=\'STANDBY\'','--json'],
    ['d1','execute','DB','--local','--file','backup.sql'],['secret','put','ADMIN_API_KEY']
  ])assert.equal(closeoutAllowed(args,b),false);
});
