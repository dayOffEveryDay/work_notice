import assert from 'node:assert/strict';
import test from 'node:test';
import { localPlan,validateRemote,validateVersion,parseMetadata,permitted,metadataSql,tables } from '../production-backup.mjs';

// Pure synthetic response tests. No Wrangler, network, SQL import or production data.
const b=await localPlan();
function fixture(){
  return {who:{loggedIn:true,accounts:[{id:b.accountId}]},
    deployments:[{id:'synthetic-deployment',created_on:'2026-11-02',versions:[{version_id:b.versionId,percentage:100}]}],
    version:{id:b.versionId,resources:{script_runtime:{compatibility_date:b.compatibilityDate},bindings:[
      {type:'d1',name:'DB',id:b.databaseId},...b.secretNames.map(name=>({type:'secret_text',name})),
      ...Object.entries(b.vars).map(([name,text])=>({type:'plain_text',name,text}))]}},
    database:{uuid:b.databaseId,name:b.databaseName},
    metadata:{ledger:structuredClone(b.migrations),schema:[...tables,'d1_migrations'].map(name=>({type:'table',name})).concat(
      ['cancel_disabled_pushes','enqueue_mobile_alert','enqueue_mobile_offline'].map(name=>({type:'trigger',name}))),counts:{...b.counts}}
  };
}
const validate=f=>validateRemote(b,f.who,f.deployments,f.version,f.database,f.metadata);
test('local plan pins actual config and all three reviewed migration hashes',()=>{
  assert.equal(b.worker,'work-notice-api');assert.equal(Object.keys(b.migrationHashes).length,3);
});
test('matching synthetic metadata passes without exposing bindings or account email',()=>{
  const f=fixture();f.who.email='PRIVATE-CANARY';const result=validate(f);
  assert.equal(result.versionId,b.versionId);assert.ok(!JSON.stringify(result).includes('PRIVATE-CANARY'));
});
for(const field of ['account','version','binding','database','ledger','count'])test(field+' mismatch stops',()=>{
  const f=fixture();
  if(field==='account')f.who.accounts[0].id='wrong-account';
  if(field==='version')f.deployments[0].versions[0].version_id='wrong-version';
  if(field==='binding')f.version.resources.bindings[0].id='wrong-db';
  if(field==='database')f.database.uuid='wrong-db';
  if(field==='ledger')f.metadata.ledger.push({id:3,name:'0003_scheduled_activation.sql'});
  if(field==='count')f.metadata.counts.alert_events++;
  assert.throws(()=>validate(f),/mismatch|Count drift/);
});
test('unexpected remote test var is rejected without logging its value',()=>{
  const f=fixture();f.version.resources.bindings.push({type:'plain_text',name:'TEST_TOKEN',text:'PRIVATE-CANARY'});
  assert.throws(()=>validateVersion(b,f.version),error=>!error.message.includes('PRIVATE-CANARY')&&error.message.includes('mismatch'));
});
test('D1 SELECT results must prove zero writes',()=>{
  const make=()=>Array.from({length:3},(_,i)=>({success:true,results:i===2?[{agents:1}]:[],meta:{rows_written:0,changed_db:false}}));
  assert.equal(parseMetadata(make(),true).counts.agents,1);
  const bad=make();bad[0].meta.rows_written=1;assert.throws(()=>parseMetadata(bad,true),/Unexpected D1 write/);
});
test('phase-one allowlist accepts only exact reviewed remote SELECT/export commands',()=>{
  assert.equal(permitted(['d1','execute',b.databaseName,'--remote','--command',metadataSql,'--json'],b),true);
  assert.equal(permitted(['d1','export',b.databaseName,'--remote','--output','private.sql'],b,undefined,'private.sql'),true);
  for(const args of [
    ['deploy'],['deploy','--dry-run'],['d1','migrations','apply','DB','--remote'],
    ['d1','execute',b.databaseName,'--remote','--file','private.sql'],
    ['d1','execute',b.databaseName,'--remote','--command','DELETE FROM agents','--json'],
    ['d1','time-travel','restore',b.databaseName,'--bookmark','wrong'],['secret','put','ADMIN_API_KEY']
  ])assert.equal(permitted(args,b,undefined,'private.sql'),false);
});
test('no implicit local import is permitted without isolated config/state',()=>{
  assert.equal(permitted(['d1','execute','DB','--local','--file','private.sql'],b,undefined,'private.sql'),false);
});
