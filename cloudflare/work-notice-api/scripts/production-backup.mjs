import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareMetadata, verifyExistingBackup } from './backup-verification.mjs';

const exec = promisify(execFile);
const project = fileURLToPath(new URL('../', import.meta.url));
const wrangler = path.join(project, 'node_modules/wrangler/bin/wrangler.js');
export const tables = ['agents','alert_events','alert_settings','request_nonces','agent_status_transitions',
  'android_devices','mobile_pairings','push_jobs','mobile_acks','mobile_rate_limits'];
const ledgerSql = 'SELECT id,name,applied_at FROM d1_migrations ORDER BY id';
const schemaSql = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name";
const countsSql = 'SELECT ' + tables.map(t => `(SELECT COUNT(*) FROM "${t}") AS "${t}"`).join(',');
export const metadataSql = `${ledgerSql}; ${schemaSql}; ${countsSql};`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const equal = (a,b,label) => {
  try { assert.deepEqual(a,b); } catch { throw new Error(label + ': mismatch; STOP (no values disclosed)'); }
};

export async function localPlan() {
  const baseline = JSON.parse(await readFile(new URL('./production-backup-baseline.json', import.meta.url),'utf8'));
  const config = JSON.parse(await readFile(path.join(project,'wrangler.jsonc'),'utf8'));
  equal(config.name,baseline.worker,'Local Worker name');
  equal(config.env,undefined,'Unexpected named environment');
  equal(config.d1_databases.length,1,'D1 binding count');
  equal(config.d1_databases[0],{binding:'DB',database_name:baseline.databaseName,database_id:baseline.databaseId,
    migrations_dir:'migrations',remote:false},'Local DB binding');
  equal(config.vars,baseline.vars,'Local vars');
  equal(config.compatibility_date,baseline.compatibilityDate,'Compatibility date');
  equal(config.triggers,{crons:['* * * * *']},'Cron');
  const files=(await readdir(path.join(project,'migrations'))).filter(x=>x.endsWith('.sql')).sort();
  equal(files,Object.keys(baseline.migrationHashes),'Local migration file set');
  for(const file of files)equal(hash(await readFile(path.join(project,'migrations',file))),baseline.migrationHashes[file],'SQL SHA-256 '+file);
  for(const key of ['CLOUDFLARE_ENV','WRANGLER_ENV','CLOUDFLARE_API_BASE_URL','CLOUDFLARE_API_ENVIRONMENT']) {
    if(process.env[key])throw new Error('Unexpected environment override '+key+'; STOP');
  }
  if(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_ACCOUNT_ID!==baseline.accountId)throw new Error('Account environment override differs; STOP');
  for(const file of ['.env','.env.local']) {
    if(await stat(path.join(project,file)).then(()=>true,()=>false))throw new Error('Unexpected '+file+'; review before execution');
  }
  return baseline;
}

export function validateVersion(baseline, version) {
  equal(version.id,baseline.versionId,'Worker version');
  equal(version.resources?.script_runtime?.compatibility_date,baseline.compatibilityDate,'Remote compatibility date');
  const bindings=version.resources?.bindings??[];
  equal(bindings.filter(x=>x.type==='d1').map(x=>({name:x.name,id:x.id})),[{name:'DB',id:baseline.databaseId}],'Remote D1 binding');
  equal(bindings.filter(x=>x.type==='secret_text').map(x=>x.name).sort(),[...baseline.secretNames].sort(),'Secret binding names');
  equal(Object.fromEntries(bindings.filter(x=>x.type==='plain_text').map(x=>[x.name,x.text])),baseline.vars,'Remote vars');
  equal(bindings.length,1+baseline.secretNames.length+Object.keys(baseline.vars).length,'Unexpected binding');
}

export function validateRemote(baseline, who, deployments, version, database, metadata) {
  equal(who.loggedIn,true,'Cloudflare login');
  equal(who.accounts?.map(x=>x.id).sort(),[baseline.accountId],'Cloudflare account membership');
  const latest=[...deployments].sort((a,b)=>a.created_on.localeCompare(b.created_on)).at(-1);
  equal(latest?.versions,[{version_id:baseline.versionId,percentage:100}],'Current production version/traffic');
  validateVersion(baseline,version);
  equal(database.uuid,baseline.databaseId,'Actual D1 UUID');equal(database.name,baseline.databaseName,'Actual D1 name');
  equal(metadata.ledger,baseline.migrations,'Applied migrations');
  const pending=Object.keys(baseline.migrationHashes).filter(x=>!metadata.ledger.some(m=>m.name===x));
  equal(pending,['0003_scheduled_activation.sql'],'Pending migrations');
  equal(metadata.schema.filter(x=>x.type==='table').map(x=>x.name).sort(),[...tables,'d1_migrations'].sort(),'Production table set');
  equal(metadata.schema.filter(x=>x.type==='trigger').map(x=>x.name).sort(),['cancel_disabled_pushes','enqueue_mobile_alert','enqueue_mobile_offline'],'Production trigger set');
  for(const [table,count]of Object.entries(baseline.counts)) {
    if(metadata.counts[table]!==count)throw new Error(`Count drift for ${table}: expected ${count}, actual ${metadata.counts[table]}; STOP`);
  }
  return {accountId:baseline.accountId,worker:baseline.worker,versionId:version.id,deploymentId:latest.id,
    databaseName:database.name,databaseId:database.uuid,pending,secretNames:baseline.secretNames,
    counts:metadata.counts,ledger:metadata.ledger};
}

export function parseMetadata(results, remote = false) {
  if(!Array.isArray(results)||results.length!==3||results.some(x=>!x.success))throw new Error('D1 metadata query failed; STOP');
  if(remote&&results.some(x=>x.meta?.rows_written!==0||x.meta?.changed_db!==false))throw new Error('Unexpected D1 write metadata; STOP');
  if(results[2].results.length!==1)throw new Error('D1 count result invalid; STOP');
  return {ledger:results[0].results,schema:results[1].results,counts:results[2].results[0]};
}

// Fixed command allowlist: no deploy, migration command, status PUT or remote file import.
export function permitted(args, b, localConfig, sqlFile) {
  if(args.includes('--env')||args.includes('--preview'))return false;
  const head=args.slice(0,2).join(' ');
  if(args[0]==='whoami')return equalArgs(args,['whoami','--json']);
  if(head==='deployments list')return equalArgs(args,['deployments','list','--name',b.worker,'--json']);
  if(head==='versions view')return equalArgs(args,['versions','view',b.versionId,'--name',b.worker,'--json']);
  if(head==='d1 info')return equalArgs(args,['d1','info',b.databaseName,'--json']);
  if(head==='d1 time-travel')return equalArgs(args,['d1','time-travel','info',b.databaseName,'--json']);
  if(head==='d1 export')return equalArgs(args,['d1','export',b.databaseName,'--remote','--output',sqlFile]);
  if(head==='d1 execute') {
    if(equalArgs(args,['d1','execute',b.databaseName,'--remote','--command',metadataSql,'--json']))return true;
    if(!localConfig)return false;
    const prefix=['d1','execute','DB','--local','--persist-to',path.join(path.dirname(localConfig),'state')];
    return equalArgs(args,[...prefix,'--file',sqlFile,'--json'])||
      equalArgs(args,[...prefix,'--command',metadataSql,'--json'])||
      equalArgs(args,[...prefix,'--command','PRAGMA quick_check; PRAGMA foreign_key_check;','--json']);
  }
  return false;
}
const equalArgs=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);

export async function executeBackup(b, folder) {
  // The PS wrapper creates this new directory and restricts its ACL before execution.
  const expectedRoot=path.resolve(project,'../../artifacts/production-backups')+path.sep;
  if(!path.resolve(folder).startsWith(expectedRoot))throw new Error('Backup directory must be inside artifacts/production-backups');
  if((await readdir(folder)).length!==0)throw new Error('Backup directory is not empty; refusing overwrite');
  const sqlFile=path.join(folder,'work-notice-db.sql'),manifest={status:'IN_PROGRESS',startedAt:new Date().toISOString(),steps:[],target:b};
  const config=path.join(project,'wrangler.jsonc');let step='initialization';
  const save=()=>writeFile(path.join(folder,'manifest.json'),JSON.stringify(manifest,null,2));
  async function run(label,args,{json=true,localConfig}={}) {
    step=label;
    if(!permitted(args,b,localConfig,sqlFile))throw new Error('Command outside phase-one allowlist');
    const scope=localConfig?'writes/reads isolated LOCAL restore only; no Worker runs':args[1]==='export'?
      'production SQL export; temporarily BLOCKS other D1 requests; writes private local SQL':'production metadata SELECT/read only';
    console.log(`${label}: target=${localConfig?'ISOLATED LOCAL D1':b.accountId+'/'+b.worker+'/'+b.databaseName}; scope=${scope}`);
    const env={...process.env,WRANGLER_SEND_METRICS:'false',BROWSER:'none',CI:'true',
      WRANGLER_LOG_PATH:path.join(folder,'private-cli-logs'),CLOUDFLARE_ACCOUNT_ID:b.accountId};
    if(localConfig){for(const key of Object.keys(env))if(/^(CLOUDFLARE_|CF_)/.test(key))delete env[key];env.XDG_CONFIG_HOME=path.join(folder,'local-cli-profile');}
    let result;
    try {result=await exec(process.execPath,[wrangler,...args,'--config',localConfig??config],
      {cwd:project,windowsHide:true,timeout:240000,maxBuffer:16*1024*1024,env});}
    catch {throw new Error(label+': command failed; raw output withheld for privacy; STOP');}
    // Do not echo raw Wrangler output: export can contain a signed download URL.
    let value;
    try {value=json?JSON.parse(result.stdout):undefined;}
    catch {throw new Error(label+': invalid JSON output; STOP');}
    manifest.steps.push({label,completedAt:new Date().toISOString()});await save();
    return value;
  }
  try {
    const who=await run('READ account',['whoami','--json']);
    equal(who.loggedIn,true,'Cloudflare login');equal(who.accounts?.map(x=>x.id).sort(),[b.accountId],'Cloudflare account membership');
    const deployments=await run('READ deployments',['deployments','list','--name',b.worker,'--json']);
    const latest=[...deployments].sort((a,c)=>a.created_on.localeCompare(c.created_on)).at(-1);
    equal(latest?.versions,[{version_id:b.versionId,percentage:100}],'Current version/traffic');
    const version=await run('READ version/bindings',['versions','view',b.versionId,'--name',b.worker,'--json']);
    validateVersion(b,version);
    const database=await run('READ database identity',['d1','info',b.databaseName,'--json']);
    equal(database.uuid,b.databaseId,'Actual D1 UUID');equal(database.name,b.databaseName,'Actual D1 name');
    const before=parseMetadata(await run('SELECT migrations/schema/counts',['d1','execute',b.databaseName,'--remote','--command',metadataSql,'--json']),true);
    manifest.preflight=validateRemote(b,who,deployments,version,database,before);await save();
    // Preserve the actual query result and provenance, not just counts in the manifest.
    await writeFile(path.join(folder,'metadata-pre-export.json'),JSON.stringify(before,null,2));
    await writeFile(path.join(folder,'worker-before.json'),JSON.stringify({versionId:version.id,deploymentId:latest.id,compatibilityDate:b.compatibilityDate,databaseId:b.databaseId},null,2));
    await run('EXPORT production SQL',['d1','export',b.databaseName,'--remote','--output',sqlFile],{json:false});
    if((await stat(sqlFile)).size===0)throw new Error('Empty SQL export; STOP');
    manifest.sqlSha256=hash(await readFile(sqlFile));
    await writeFile(path.join(folder,'work-notice-db.sql.sha256'),manifest.sqlSha256+'  work-notice-db.sql\n');
    // No migrations are run: import the exact backup into a new random local binding.
    const localConfig=path.join(folder,'restore-check.json');
    await writeFile(localConfig,JSON.stringify({name:'backup-restore-local-only',compatibility_date:b.compatibilityDate,
      d1_databases:[{binding:'DB',database_name:'backup-local-'+randomUUID(),database_id:randomUUID(),remote:false}]},null,2));
    const prefix=['d1','execute','DB','--local','--persist-to',path.join(folder,'state')];
    await run('LOCAL restore exact SQL',[...prefix,'--file',sqlFile,'--json'],{localConfig});
    const restored=parseMetadata(await run('LOCAL compare restored metadata',[...prefix,'--command',metadataSql,'--json'],{localConfig}));
    await writeFile(path.join(folder,'metadata-restored.json'),JSON.stringify(restored,null,2));
    step='LOCAL validate export snapshot against existing restored D1';
    const verification=await verifyExistingBackup(folder,{preflight:before});
    await writeFile(path.join(folder,'snapshot-comparison.json'),JSON.stringify(verification,null,2));
    manifest.restoreValidation=verification.restoreValidation;
    manifest.preflightVsExport=verification.preflightVsExport;
    await save();printVerification(verification);
    if(verification.restoreValidation.status!=='PASS')throw new Error('Export snapshot/local restore mismatch; STOP');
    // Different timestamps are NOT evidence of a corrupt restore. Still keep the
    // user's strict no-drift gate: do not ignore nonces or accept a new baseline.
    if(!verification.preflightVsExport?.equal)throw new Error('Local snapshot restore PASS; pre-export/export window drift requires review; STOP');
    const integrity=await run('LOCAL SQLite consistency',[...prefix,'--command','PRAGMA quick_check; PRAGMA foreign_key_check;','--json'],{localConfig});
    equal(integrity.map(x=>x.success),[true,true],'SQLite validation');
    if(integrity[0].results.length!==1||Object.values(integrity[0].results[0])[0]!=='ok'||integrity[1].results.length!==0)throw new Error('Local integrity validation failed; STOP');
    equal(hash(await readFile(sqlFile)),manifest.sqlSha256,'SQL hash after local restore');
    const after=parseMetadata(await run('SELECT post-backup production counts',['d1','execute',b.databaseName,'--remote','--command',metadataSql,'--json']),true);
    // Live Heartbeat/Cron can legitimately change counters: still STOP, never silently rebaseline.
    manifest.postflightComparison=compareMetadata(before,after);await save();
    if(!manifest.postflightComparison.equal){
      printMetadataDifference('PRODUCTION_WINDOW',manifest.postflightComparison);
      throw new Error('Production changed during backup window; STOP');
    }
    const finalDeployments=await run('READ final version guard',['deployments','list','--name',b.worker,'--json']);
    const final=[...finalDeployments].sort((a,c)=>a.created_on.localeCompare(c.created_on)).at(-1);
    equal(final?.id,latest.id,'Deployment changed during backup');
    const bookmark=await run('READ latest Time Travel bookmark',['d1','time-travel','info',b.databaseName,'--json']);
    const current=bookmark.bookmark??bookmark.current_bookmark;
    if(typeof current!=='string'||! /^[a-f0-9]{8}-[a-f0-9]{8}-[a-f0-9]{8}-[a-f0-9]{32}$/i.test(current))throw new Error('Time Travel bookmark format unexpected; STOP');
    manifest.bookmark={value:current,capturedAt:new Date().toISOString()};
    await writeFile(path.join(folder,'time-travel-before.json'),JSON.stringify(manifest.bookmark,null,2));
    manifest.status='PASS';manifest.finishedAt=new Date().toISOString();await save();
    console.log('PASS: stage one backup and isolated local restore verified. SQL SHA-256='+manifest.sqlSha256);
    console.log('Backup directory: '+folder);
    console.log('STOP HERE. No migration/deploy is part of this procedure.');
  } catch(error) {
    manifest.status='STOPPED';manifest.failedStep=step;manifest.reason=error.message;
    await save();throw error;
  }
}

async function main() {
  const args=process.argv.slice(2);
  if(args.length===2&&args[0]==='--diagnose-existing'){
    const folder=path.resolve(args[1]);
    const root=path.resolve(project,'../../artifacts/production-backups')+path.sep;
    if(!folder.startsWith(root))throw new Error('Diagnosis must use an existing private backup directory');
    // Entire branch is offline. No localPlan/auth/CLI/network or reimport occurs.
    const result=await verifyExistingBackup(folder);
    await writeFile(path.join(folder,'local-verification-diagnosis.json'),JSON.stringify(result,null,2));
    printVerification(result);
    console.log('OFFLINE ONLY: original manifest and SQL unchanged. Stage one remains incomplete; no deployment.');
    if(result.restoreValidation.status!=='PASS'||result.missingEvidence.length)process.exitCode=1;
    return;
  }
  const b=await localPlan();
  if(args.length===0){
    console.log('PLAN ONLY: local config and migration hashes PASS. No production request made.');
    console.log(JSON.stringify({accountId:b.accountId,worker:b.worker,versionId:b.versionId,databaseName:b.databaseName,
      databaseId:b.databaseId,expectedApplied:b.migrations,onlyPending:'0003_scheduled_activation.sql',baselineCounts:b.counts,
      operations:['read account','read deployments/version/bindings','read D1 identity','SELECT ledger/schema/counts',
        'export SQL into private folder (temporarily blocks D1 requests)','hash SQL','isolated LOCAL import/quick_check/metadata checks',
        'repeat production SELECT/version guard','read latest bookmark','STOP; no migration/deploy']},null,2));return;
  }
  if(args.length!==2||args[0]!=='--execute')throw new Error('Use reviewed PowerShell wrapper; no implicit execution');
  await executeBackup(b,path.resolve(args[1]));
}

function printMetadataDifference(label,result) {
  console.log(`${label}: schema=${result.schemaEqual?'MATCH':'DIFFERENT'} ledger=${result.ledgerEqual?'MATCH':'DIFFERENT'} counts=${result.countsEqual?'MATCH':'DIFFERENT'}`);
  for(const kind of ['missing','extra','changed'])for(const row of result.schema[kind])console.log(`SCHEMA ${kind}: ${row.type} ${row.name}`);
  for(const kind of ['missing','extra','changed'])for(const row of result.ledger[kind])console.log(`MIGRATION ${kind}: id=${row.id} name=${row.name}`);
  for(const row of result.counts)console.log(`COUNT ${row.table}: expected=${row.expected} actual=${row.actual}`);
}

function printVerification(result) {
  console.log('EXPORT_SNAPSHOT_TO_RESTORE: '+result.restoreValidation.status);
  printMetadataDifference('SNAPSHOT',result.restoreValidation.metadata);
  for(const row of result.restoreValidation.tables)console.log(`TABLE ${row.table}: export=${row.exportRows} restored=${row.restoredRows} contentEqual=${row.allColumnValuesEqual} constraintsEqual=${row.constraintsAndIndexesEqual}`);
  if(result.preflightVsExport)printMetadataDifference('PRE_EXPORT_TO_SNAPSHOT',result.preflightVsExport);
  else console.log('PRE_EXPORT_TO_SNAPSHOT: UNKNOWN (recorded full metadata unavailable)');
  console.log('LOCAL_CHECKS: '+JSON.stringify(result.restoreValidation.checks));
  console.log('TIME_TRAVEL_BOOKMARK_RECORDED: '+result.hasTimeTravelBookmark);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{
  // Only errors constructed above can reach this output; never emit child exception objects.
  console.error(error.message.startsWith('ENOENT')?'Required local file missing; STOP':error.message);process.exitCode=1;
});
