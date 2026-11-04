import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSqlSnapshot,inspectSnapshot,compareSnapshots,compareMetadata,verifyExistingBackup,recoverPreflight } from '../backup-verification.mjs';

const project=fileURLToPath(new URL('../../',import.meta.url));
const schema=(await Promise.all(['0001_init.sql','0002_android_fcm.sql'].map(f=>readFile(path.join(project,'migrations',f),'utf8')))).join('\n');
const canary='SYNTHETIC-CREDENTIAL-CANARY';
function fixture(){
  const db=openSqlSnapshot(schema+`;
    CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TEXT);
    INSERT INTO d1_migrations VALUES(1,'0001_init.sql','2026-11-02 07:36:41'),(2,'0002_android_fcm.sql','2026-11-02 14:10:44');
    INSERT INTO agents(device_id,created_at_ms,updated_at_ms) VALUES('synthetic',1,1);
    INSERT INTO alert_settings(device_id,updated_at_ms) VALUES('synthetic',1);
    INSERT INTO android_devices(mobile_id,device_id,bearer_hash,fcm_cipher,created_at_ms,updated_at_ms)
      VALUES('synthetic-phone','synthetic','synthetic-bearer-hash','${canary}',1,1);
    INSERT INTO push_jobs(device_id,mobile_id,event_id,push_type,created_at_ms,expires_at_ms,next_attempt_ms)
      VALUES('synthetic','synthetic-phone','synthetic-event','WORK_ALERT',1,120001,1);
  `);
  for(let i=0;i<5;i++)db.prepare('INSERT INTO request_nonces VALUES(?,?,?)').run('synthetic','nonce-'+i,1000+i);
  return db;
}
const sixth=db=>db.exec("INSERT INTO request_nonces VALUES('synthetic','nonce-export-snapshot',2000)");
const literal=v=>v===null?'NULL':typeof v==='bigint'||typeof v==='number'?String(v):v instanceof Uint8Array?
  "X'"+Buffer.from(v).toString('hex')+"'":"'"+v.replaceAll("'","''")+"'";
function dump(db){
  const objects=db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const lines=objects.filter(x=>x.type==='table').map(x=>x.sql+';');
  for(const table of objects.filter(x=>x.type==='table')){
    const statement=db.prepare(`SELECT * FROM "${table.name}"`);statement.setReadBigInts(true);
    for(const row of statement.all())lines.push(`INSERT INTO "${table.name}" VALUES(${Object.values(row).map(literal).join(',')});`);
  }
  if(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'").get()){
    lines.push('DELETE FROM sqlite_sequence;');
    for(const row of db.prepare('SELECT name,seq FROM sqlite_sequence').all())lines.push(`INSERT INTO sqlite_sequence VALUES(${literal(row.name)},${row.seq});`);
  }
  lines.push(...objects.filter(x=>x.type!=='table').map(x=>x.sql+';'));
  return lines.join('\n');
}

test('5->6 nonce during export is window drift, while exact snapshot restore passes',()=>{
  const source=fixture();let restored;
  try{
    const before=inspectSnapshot(source);sixth(source);const expected=inspectSnapshot(source);
    restored=openSqlSnapshot(dump(source));const actual=inspectSnapshot(restored);
    assert.equal(compareSnapshots(expected,actual).status,'PASS');
    const drift=compareMetadata(before.metadata,expected.metadata);
    assert.deepEqual(drift.counts,[{table:'request_nonces',expected:5,actual:6}]);
    assert.equal(drift.schemaEqual,true);assert.equal(drift.ledgerEqual,true);assert.equal(drift.equal,false);
  }finally{source.close();restored?.close();}
});
for(const object of ['trigger','index','table'])test('missing '+object+' remains a real structure failure',()=>{
  const source=fixture(),target=openSqlSnapshot(dump(source));
  try{
    const name=object==='trigger'?'enqueue_mobile_alert':object==='index'?'push_due':'mobile_acks';
    target.exec(`DROP ${object} ${name}`);
    const r=compareSnapshots(inspectSnapshot(source),inspectSnapshot(target));
    assert.equal(r.status,'FAIL');assert.ok(r.metadata.schema.missing.some(x=>x.name===name));
  }finally{source.close();target.close();}
});
test('changed CHECK constraints are not accepted as formatting differences',()=>{
  const source=fixture(),original=dump(source),changed=original.replace('enabled IN (0, 1)','enabled IN (0, 1, 2)');
  assert.notEqual(changed,original);const target=openSqlSnapshot(changed);
  try{const r=compareSnapshots(inspectSnapshot(source),inspectSnapshot(target));assert.equal(r.status,'FAIL');assert.ok(r.metadata.schema.changed.some(x=>x.name==='alert_settings'));}
  finally{source.close();target.close();}
});
for(const kind of ['missing','extra','timestamp'])test('migration '+kind+' is separately diagnosed',()=>{
  const source=fixture(),target=openSqlSnapshot(dump(source));
  try{
    if(kind==='missing')target.exec('DELETE FROM d1_migrations WHERE id=2');
    if(kind==='extra')target.exec("INSERT INTO d1_migrations VALUES(3,'0003_scheduled_activation.sql','later')");
    if(kind==='timestamp')target.exec("UPDATE d1_migrations SET applied_at='changed' WHERE id=2");
    const r=compareSnapshots(inspectSnapshot(source),inspectSnapshot(target));
    assert.equal(r.status,'FAIL');assert.equal(r.metadata.ledgerEqual,false);
    const entry=r.metadata.ledger[kind==='timestamp'?'changed':kind][0];assert.equal(entry.id,kind==='extra'?3:2);
  }finally{source.close();target.close();}
});
for(const field of ['fcm_cipher','bearer_hash'])test('same row counts but changed '+field+' fail without disclosure',()=>{
  const source=fixture(),target=openSqlSnapshot(dump(source));
  try{
    target.exec(`UPDATE android_devices SET ${field}='changed-${canary}'`);
    const r=compareSnapshots(inspectSnapshot(source),inspectSnapshot(target));
    assert.equal(r.status,'FAIL');assert.equal(r.metadata.countsEqual,true);
    assert.equal(r.tables.find(x=>x.table==='android_devices').allColumnValuesEqual,false);
    assert.ok(!JSON.stringify(r).includes(canary));assert.ok(!JSON.stringify(r).includes('synthetic-bearer-hash'));
  }finally{source.close();target.close();}
});
test('an extra nonce in restored DB rather than export is a real restoration mismatch',()=>{
  const source=fixture(),target=openSqlSnapshot(dump(source));
  try{sixth(target);const r=compareSnapshots(inspectSnapshot(source),inspectSnapshot(target));assert.equal(r.status,'FAIL');assert.deepEqual(r.metadata.counts,[{table:'request_nonces',expected:5,actual:6}]);}
  finally{source.close();target.close();}
});
test('platform _cf tables are excluded but PK/UNIQUE autoindexes remain checked',()=>{
  const source=fixture(),target=openSqlSnapshot(dump(source));
  try{
    target.exec("CREATE TABLE _cf_KV(key TEXT PRIMARY KEY,value TEXT); INSERT INTO _cf_KV VALUES('platform','private-platform-value')");
    const a=inspectSnapshot(source),b=inspectSnapshot(target);assert.equal(compareSnapshots(a,b).status,'PASS');
    const auto=b.structures.android_devices.indexes.find(x=>x.origin==='pk');assert.ok(auto);auto.unique=0;
    const r=compareSnapshots(a,b);assert.equal(r.status,'FAIL');assert.equal(r.tables.find(x=>x.table==='android_devices').constraintsAndIndexesEqual,false);
  }finally{source.close();target.close();}
});
test('sqlite_sequence is checked rather than silently discarded as an internal table',()=>{
  const source=fixture(),target=openSqlSnapshot(dump(source));
  try{
    target.exec("UPDATE sqlite_sequence SET seq=99 WHERE name='push_jobs'");
    const r=compareSnapshots(inspectSnapshot(source),inspectSnapshot(target));assert.equal(r.status,'FAIL');assert.equal(r.checks.sequenceEqual,false);
  }finally{source.close();target.close();}
});
test('all-column comparison handles int64 and BLOB values without precision loss',()=>{
  const source=fixture();source.exec("CREATE TABLE synthetic_types(id TEXT PRIMARY KEY,n INTEGER,b BLOB); INSERT INTO synthetic_types VALUES('t',9223372036854775806,X'0001FF')");
  const target=openSqlSnapshot(dump(source));
  try{assert.equal(compareSnapshots(inspectSnapshot(source),inspectSnapshot(target)).status,'PASS');}
  finally{source.close();target.close();}
});
test('offline SQL cannot attach a filesystem database and does not expose SQL in errors',()=>{
  assert.throws(()=>openSqlSnapshot("ATTACH DATABASE '"+canary+".sqlite' AS external"),e=>e.message.includes('safely')&&!e.message.includes(canary));
});

async function privateFixture({logs=false,missingBefore=false}={}){
  const folder=path.join(project,'.wrangler','backup-verification-tests',randomUUID());
  await mkdir(path.join(folder,'state/v3/d1/miniflare-D1DatabaseObject'),{recursive:true});
  const source=fixture(),before=inspectSnapshot(source).metadata;sixth(source);const sql=dump(source);source.close();
  const digest=createHash('sha256').update(sql).digest('hex');
  const manifest={status:'STOPPED',sqlSha256:digest,preflight:{databaseId:'synthetic-production-id',counts:before.counts,ledger:before.ledger},steps:[
    {label:'SELECT migrations/schema/counts',completedAt:'2026-11-03T11:10:53.247Z'},
    {label:'EXPORT production SQL',completedAt:'2026-11-03T11:10:58.263Z'}]};
  await writeFile(path.join(folder,'manifest.json'),JSON.stringify(manifest));
  await writeFile(path.join(folder,'work-notice-db.sql'),sql);
  await writeFile(path.join(folder,'work-notice-db.sql.sha256'),digest+'  work-notice-db.sql\n');
  await writeFile(path.join(folder,'restore-check.json'),JSON.stringify({d1_databases:[{binding:'DB',database_name:'backup-local-synthetic',database_id:randomUUID(),remote:false}]}));
  if(!missingBefore){
    if(logs){
      await mkdir(path.join(folder,'private-cli-logs'));
      const value=[before.ledger,before.schema,[before.counts]].map(results=>({success:true,results}));
      await writeFile(path.join(folder,'private-cli-logs/synthetic.log'),'--- 2026-11-03T11:10:53.000Z log\n'+JSON.stringify(value)+'\n---\n'+canary);
    }else await writeFile(path.join(folder,'metadata-pre-export.json'),JSON.stringify(before));
  }
  const db=new DatabaseSync(path.join(folder,'state/v3/d1/miniflare-D1DatabaseObject/synthetic.sqlite'));db.exec(sql);db.close();
  // These are storage metadata files, never the application database.
  const storage=new DatabaseSync(path.join(folder,'state/v3/d1/miniflare-D1DatabaseObject/metadata.sqlite'));storage.exec('CREATE TABLE storage_metadata(x)');storage.close();
  return {folder,manifest};
}
test('existing private artifacts are verified offline with distinct source times and unchanged originals',async()=>{
  const {folder}=await privateFixture();
  const before=await readFile(path.join(folder,'manifest.json'));
  const r=await verifyExistingBackup(folder);
  assert.equal(r.restoreValidation.status,'PASS');assert.equal(r.preflightVsExport.countsEqual,false);
  assert.equal(r.stageOneComplete,false);assert.equal(r.hasTimeTravelBookmark,false);
  assert.deepEqual(await readFile(path.join(folder,'manifest.json')),before);
  assert.ok(!JSON.stringify(r).includes(canary));
});
test('old metadata can be safely recovered from private CLI logs without returning raw logs',async()=>{
  const {folder}=await privateFixture({logs:true});const r=await verifyExistingBackup(folder);
  assert.equal(r.restoreValidation.status,'PASS');assert.equal(r.preflightSource,'synthetic.log');assert.deepEqual(r.missingEvidence,[]);
  assert.ok(!JSON.stringify(r).includes(canary));
});
test('missing recorded pre-export schema is UNKNOWN, not silently reconstructed or accepted',async()=>{
  const {folder,manifest}=await privateFixture({missingBefore:true});assert.equal(await recoverPreflight(folder,manifest),null);
  const r=await verifyExistingBackup(folder);assert.equal(r.restoreValidation.status,'PASS');
  assert.equal(r.preflightVsExport,null);assert.equal(r.missingEvidence.length,1);assert.equal(r.stageOneComplete,false);
});
test('backup file modification is rejected even when SQL semantics would be unchanged',async()=>{
  const {folder}=await privateFixture();const file=path.join(folder,'work-notice-db.sql');await writeFile(file,(await readFile(file,'utf8'))+'\n');
  await assert.rejects(()=>verifyExistingBackup(folder),/SHA-256/);
});
