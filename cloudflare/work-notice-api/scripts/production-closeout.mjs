import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localPlan,validateVersion,parseMetadata,metadataSql,tables } from './production-backup.mjs';
import { verifyExistingBackup,readExportSnapshot,compareMetadata } from './backup-verification.mjs';

const exec=promisify(execFile),project=fileURLToPath(new URL('../',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const protectedFiles=['work-notice-db.sql','manifest.json','work-notice-db.sql.sha256','worker-before.json','restore-check.json'];
const equal=(a,b,label)=>{try{assert.deepEqual(a,b);}catch{throw new Error(label+': mismatch; STOP (private details withheld)');}};
const sameArgs=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);

export function acceptReviewedBackup(verification,review) {
  equal(verification.sqlSha256,review.sqlSha256,'Original SQL SHA-256');
  equal(verification.restoreValidation.status,'PASS','Original restore validation');
  equal(verification.originalStageStatus,'STOPPED','Original immutable manifest status');
  equal(verification.missingEvidence,[],'Recorded pre-export evidence');
  const drift=verification.preflightVsExport;
  equal(drift?.schemaEqual,true,'Historical schema');equal(drift?.ledgerEqual,true,'Historical migration ledger');
  equal(drift?.counts,review.acceptedBackupWindowDrift,'Only reviewed historical drift');
  return {status:'REVIEWED_AND_ACCEPTED',differences:review.acceptedBackupWindowDrift,scope:'Original pre-export SELECT versus SQL export snapshot only'};
}

export function currentMetadataCheck(baseline,exportMetadata,current) {
  const difference=compareMetadata({...exportMetadata,ledger:baseline.migrations},current);
  if(!difference.ledgerEqual){
    const error=new Error('Current applied migrations: only 0001/0002 permitted; STOP');
    error.safeDifference={ledger:difference.ledger};throw error;
  }
  if(!difference.schemaEqual||!difference.ledgerEqual){
    const error=new Error('Unreviewed current Schema or migration difference; STOP');
    error.safeDifference={schema:difference.schema,ledger:difference.ledger};throw error;
  }
  equal(Object.keys(current.counts).sort(),[...tables].sort(),'Current count table set');
  for(const n of Object.values(current.counts))if(!Number.isSafeInteger(n)||n<0)throw new Error('Invalid live count; STOP');
  // These tables have no automatic row cleanup. A membership/configuration
  // cardinality change is an unknown difference, not merely event traffic.
  const needsReview=difference.counts.filter(x=>['agents','android_devices','alert_settings'].includes(x.table)||
    (x.table==='agent_status_transitions'&&x.actual<x.expected));
  if(needsReview.length){
    const error=new Error('Current identity/configuration or unpruned history count changed; review required; STOP');
    error.safeDifference={counts:needsReview};throw error;
  }
  return {schema:'PASS',ledger:'PASS',liveCountObservations:difference.counts.map(x=>({
    table:x.table,sqlSnapshotCount:x.expected,currentCount:x.actual,delta:x.actual-x.expected,
    classification:'NEWER_LIVE_DATABASE_OBSERVATION',cause:'Not inferred from counts alone; not a restore comparison'
  }))};
}

export function closeoutAllowed(args,b) {
  return [
    ['whoami','--json'],
    ['deployments','list','--name',b.worker,'--json'],
    ['versions','view',b.versionId,'--name',b.worker,'--json'],
    ['d1','info',b.databaseName,'--json'],
    ['d1','execute',b.databaseName,'--remote','--command',metadataSql,'--json'],
    ['d1','time-travel','info',b.databaseName,'--json']
  ].some(allowed=>sameArgs(args,allowed));
}

export async function loadCloseoutPlan() {
  const baseline=await localPlan();
  const review=JSON.parse(await readFile(new URL('./production-closeout-review.json',import.meta.url),'utf8'));
  if(!/^\d{8}-\d{6}-[a-f0-9]{32}$/.test(review.backupDirectory))throw new Error('Invalid reviewed backup directory');
  const folder=path.join(project,'../../artifacts/production-backups',review.backupDirectory);
  const verification=await verifyExistingBackup(folder);
  const accepted=acceptReviewedBackup(verification,review);
  const hashes={};for(const name of protectedFiles)hashes[name]=hash(await readFile(path.join(folder,name)));
  return {baseline,review,folder,verification,accepted,hashes,configSha256:hash(await readFile(path.join(project,'wrangler.jsonc')))};
}

function latestDeployment(b,deployments) {
  const latest=[...deployments].sort((a,c)=>a.created_on.localeCompare(c.created_on)).at(-1);
  equal(latest?.versions,[{version_id:b.versionId,percentage:100}],'Current production version/traffic');
  return latest;
}

export async function executeCloseout(plan) {
  const {baseline:b,folder,verification,accepted,hashes}=plan;
  const directory=path.join(folder,'closeout-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID());
  // Inherit the original private directory's ACL. No original artifact is rewritten.
  await mkdir(directory);
  const report={status:'IN_PROGRESS',stageOneComplete:false,secondStageAuthorized:false,
    startedAt:new Date().toISOString(),backupDirectory:folder,originalFilesSha256:hashes,
    originalManifestStatus:verification.originalStageStatus,backupValidation:verification.restoreValidation,
    acceptedHistoricalDrift:accepted,sqlExportCompletedAt:verification.timeline.exportCompleted,
    sqlSnapshotExactTime:'NOT_RECORDED; export completion is not an exact snapshot timestamp',steps:[],warnings:[],blockers:[]};
  const save=()=>writeFile(path.join(directory,'stage-one-closeout.json'),JSON.stringify(report,null,2));
  async function run(label,args) {
    if(!closeoutAllowed(args,b))throw new Error('Command outside read-only closeout allowlist; STOP');
    equal(hash(await readFile(path.join(project,'wrangler.jsonc'))),plan.configSha256,'Wrangler config changed during closeout');
    console.log(`${label}: account=${b.accountId}; Worker=${b.worker}; DB=${b.databaseName}/${b.databaseId}; scope=READ/SELECT ONLY`);
    const requestedAt=new Date().toISOString();let result;
    try{result=await exec(process.execPath,[path.join(project,'node_modules/wrangler/bin/wrangler.js'),...args,'--config',path.join(project,'wrangler.jsonc')],{
      cwd:project,windowsHide:true,timeout:120000,maxBuffer:8*1024*1024,
      env:{...process.env,CLOUDFLARE_ACCOUNT_ID:b.accountId,WRANGLER_SEND_METRICS:'false',BROWSER:'none',CI:'true',
        WRANGLER_LOG_PATH:path.join(directory,'private-cli-logs')}
    });}catch{throw new Error(label+': read failed; raw output withheld; STOP');}
    let value;try{value=JSON.parse(result.stdout);}catch{throw new Error(label+': invalid response; STOP');}
    report.steps.push({label,requestedAt,receivedAt:new Date().toISOString()});await save();return value;
  }
  try {
    await save();
    const who=await run('READ account',['whoami','--json']);
    equal(who.loggedIn,true,'Cloudflare login');equal(who.accounts?.map(x=>x.id).sort(),[b.accountId],'Cloudflare account');
    const deployment=latestDeployment(b,await run('READ current deployment',['deployments','list','--name',b.worker,'--json']));
    const version=await run('READ version and DB binding',['versions','view',b.versionId,'--name',b.worker,'--json']);validateVersion(b,version);
    const database=await run('READ D1 identity',['d1','info',b.databaseName,'--json']);
    equal(database.uuid,b.databaseId,'Current D1 UUID');equal(database.name,b.databaseName,'Current D1 name');
    const current=parseMetadata(await run('SELECT current ledger/schema/counts',['d1','execute',b.databaseName,'--remote','--command',metadataSql,'--json']),true);
    const {snapshot}=await readExportSnapshot(folder);
    report.postflight=currentMetadataCheck(b,snapshot.metadata,current);
    report.postflight.target={accountId:b.accountId,worker:b.worker,versionId:version.id,databaseName:b.databaseName,databaseId:b.databaseId,binding:'DB'};
    report.postflight.checkedAt=report.steps.at(-1).receivedAt;
    report.postflight.ledger=current.ledger;
    for(const item of report.postflight.liveCountObservations)console.log(`LIVE COUNT ${item.table}: SQL snapshot=${item.sqlSnapshotCount}, current=${item.currentCount}; recorded as newer live data, not a restore failure`);
    report.warnings.push('Accepted original nonce 5-to-6 drift applies only to the historical SQL export window.');
    if(report.postflight.liveCountObservations.length)report.warnings.push('Every newer live-count change is recorded separately; individual request causes were not inferred.');
    const finalDeployment=latestDeployment(b,await run('READ final version guard',['deployments','list','--name',b.worker,'--json']));
    equal(finalDeployment.id,deployment.id,'Deployment changed during closeout');
    const bookmarkResult=await run('READ latest D1 Time Travel bookmark',['d1','time-travel','info',b.databaseName,'--json']);
    if(typeof bookmarkResult.bookmark!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{8}-[a-f0-9]{8}-[a-f0-9]{32}$/i.test(bookmarkResult.bookmark))throw new Error('Unexpected bookmark format; STOP');
    report.bookmark={value:bookmarkResult.bookmark,requestedAt:report.steps.at(-1).requestedAt,retrievedAt:report.steps.at(-1).receivedAt,
      timezone:'UTC',relationToSqlBackup:'A later, separately retrieved recovery point; not the SQL export snapshot'};
    report.warnings.push('SQL backup and newly retrieved bookmark represent different times. A database restore loses subsequent changes.');
    for(const name of protectedFiles)equal(hash(await readFile(path.join(folder,name))),hashes[name],'Original artifact preservation '+name);
    report.originalFilesUnchanged=true;report.status='PASS_WITH_WARNINGS';report.stageOneComplete=true;report.finishedAt=new Date().toISOString();
    await save();
    await writeFile(path.join(directory,'time-travel-closeout.json'),JSON.stringify(report.bookmark,null,2));
    await writeFile(path.join(directory,'FINAL-STAGE1.md'),renderReport(report));
    console.log('PASS_WITH_WARNINGS: stage one closeout completed. Original SQL/manifest/sidecar unchanged.');
    console.log('Report directory: '+directory);console.log('STOP. Stage two requires separate user confirmation.');
  }catch(error){
    report.status='STOPPED';report.stageOneComplete=false;report.blockers.push(error.message);
    if(error.safeDifference)report.unreviewedDifference=error.safeDifference;
    await save();
    await writeFile(path.join(directory,'FINAL-STAGE1.md'),renderReport(report));throw error;
  }
}

function renderReport(r) {
  return `# Work Notice 0.4.0 Stage One Closeout\n\nStatus: ${r.status}\n\n`+
    `Original backup: ${r.backupDirectory}\nOriginal manifest remains: ${r.originalManifestStatus}\n`+
    `SQL export completed (UTC): ${r.sqlExportCompletedAt}\nExact SQL snapshot time: not recorded.\n\n`+
    `Backup restore verification: ${r.backupValidation.status}\nReviewed original drift: request_nonces 5 -> 6 only.\n\n`+
    `Production postflight: ${r.postflight?'schema/ledger PASS':'NOT COMPLETED'}\n`+
    (r.postflight?`Target: ${JSON.stringify(r.postflight.target)}\nLedger: ${r.postflight.ledger.map(x=>x.name).join(', ')}\n`+
      `Newer live-count observations: ${JSON.stringify(r.postflight.liveCountObservations)}\n`:'')+
    `\nNew bookmark: ${r.bookmark?.value??'NOT OBTAINED'}\nRetrieved at (UTC): ${r.bookmark?.retrievedAt??'NOT OBTAINED'}\n`+
    `The bookmark and SQL export are different recovery points.\n\nWarnings:\n${r.warnings.map(x=>'- '+x).join('\n')}\n\n`+
    `Blockers:\n${r.blockers.length?r.blockers.map(x=>'- '+x).join('\n'):'- None'}\n\n`+
    (r.unreviewedDifference?`Unreviewed differences: ${JSON.stringify(r.unreviewedDifference)}\n\n`:'')+
    `Stage one complete: ${r.stageOneComplete}\nStage two authorized: false. STOP HERE.\n`;
}

async function main(){
  const args=process.argv.slice(2);if(args.length>1||(args.length===1&&args[0]!=='--execute'))throw new Error('Use reviewed closeout wrapper');
  const plan=await loadCloseoutPlan();
  console.log(`LOCAL PASS: original backup restore and exactly reviewed nonce drift verified. Target ${plan.baseline.worker}/${plan.baseline.databaseId}`);
  if(!args.length){console.log('PLAN ONLY: no production request, no SQL export, no original artifact update.');
    console.log('After confirmation: account -> current version/bindings -> D1 identity -> SELECT schema/ledger/counts -> version guard -> latest bookmark -> new closeout report -> STOP.');return;}
  await executeCloseout(plan);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
