import { DatabaseSync, constants } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const quote = name => '"' + name.replaceAll('"', '""') + '"';
const objectKey = row => row.type + ':' + row.name;
const platformTable = name => name.startsWith('_cf_');
const same = (a,b) => isDeepStrictEqual(a,b);
const plain = rows => rows.map(row=>({...row}));

export function compareMetadata(expected, actual) {
  const expectedObjects=new Map(expected.schema.map(row=>[objectKey(row),row]));
  const actualObjects=new Map(actual.schema.map(row=>[objectKey(row),row]));
  const schema={missing:[],extra:[],changed:[]};
  for(const [key,row]of expectedObjects){
    const other=actualObjects.get(key);
    if(!other)schema.missing.push({type:row.type,name:row.name});
    else if(!same(row,other))schema.changed.push({type:row.type,name:row.name,
      fields:['tbl_name','sql'].filter(field=>row[field]!==other[field])});
  }
  for(const [key,row]of actualObjects)if(!expectedObjects.has(key))schema.extra.push({type:row.type,name:row.name});
  const ledger={missing:[],extra:[],changed:[]};
  const id=row=>String(row.id);
  const a=new Map(expected.ledger.map(row=>[id(row),row])),b=new Map(actual.ledger.map(row=>[id(row),row]));
  for(const [key,row]of a){
    const other=b.get(key);
    if(!other)ledger.missing.push({id:row.id,name:row.name});
    else if(!same(row,other))ledger.changed.push({id:row.id,name:row.name,
      fields:['name','applied_at'].filter(field=>row[field]!==other[field])});
  }
  for(const [key,row]of b)if(!a.has(key))ledger.extra.push({id:row.id,name:row.name});
  const counts=[];
  for(const table of new Set([...Object.keys(expected.counts),...Object.keys(actual.counts)])){
    if(expected.counts[table]!==actual.counts[table])counts.push({table,expected:expected.counts[table]??null,actual:actual.counts[table]??null});
  }
  const schemaEqual=!schema.missing.length&&!schema.extra.length&&!schema.changed.length;
  const ledgerEqual=!ledger.missing.length&&!ledger.extra.length&&!ledger.changed.length;
  return {equal:schemaEqual&&ledgerEqual&&!counts.length,schemaEqual,ledgerEqual,countsEqual:!counts.length,schema,ledger,counts};
}

export function openSqlSnapshot(sql) {
  const db=new DatabaseSync(':memory:',{enableLoadExtension:false});
  db.enableDefensive(true);
  // Import into RAM only. ATTACH/VACUUM INTO, extensions and file-writing pragmas
  // must never turn an offline SQL inspection into a filesystem operation.
  db.setAuthorizer((operation,arg1,arg2)=>{
    if([constants.SQLITE_ATTACH,constants.SQLITE_DETACH].includes(operation))return constants.SQLITE_DENY;
    if(operation===constants.SQLITE_FUNCTION&&['load_extension','writefile','readfile'].includes(String(arg2??arg1).toLowerCase()))return constants.SQLITE_DENY;
    if(operation===constants.SQLITE_PRAGMA&&!['foreign_keys','defer_foreign_keys','table_info','index_list',
      'index_xinfo','foreign_key_list','foreign_key_check','quick_check'].includes(String(arg1).toLowerCase()))return constants.SQLITE_DENY;
    return constants.SQLITE_OK;
  });
  try{db.exec(sql);return db;}catch{db.close();throw new Error('SQL snapshot cannot be read safely; SQL/error details withheld');}
}

function fingerprint(db,table,columns) {
  const statement=db.prepare(`SELECT * FROM ${quote(table)}`);statement.setReadBigInts(true);
  const rows=statement.all().map(row=>JSON.stringify(columns.map(c=>{
    const value=row[c.name];
    return typeof value==='bigint'?['integer',value.toString()]:value instanceof Uint8Array?
      ['blob',Buffer.from(value).toString('hex')]:[typeof value,value];
  }))).sort();
  // Keep values and digests inside this process. Public reports contain equality only.
  const h=createHash('sha256');for(const row of rows)h.update(String(Buffer.byteLength(row))+':'+row);
  return {rows:rows.length,digest:h.digest('hex')};
}

export function inspectSnapshot(db) {
  const objects=plain(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all());
  const schema=objects.filter(x=>!x.name.startsWith('sqlite_')&&!platformTable(x.name));
  const tableNames=schema.filter(x=>x.type==='table').map(x=>x.name);
  const structures={},content={},counts={};
  for(const table of tableNames){
    const columns=plain(db.prepare(`PRAGMA table_info(${quote(table)})`).all());
    const indexes=plain(db.prepare(`PRAGMA index_list(${quote(table)})`).all()).map(index=>({
      ...index,columns:plain(db.prepare(`PRAGMA index_xinfo(${quote(index.name)})`).all())
    })).sort((a,b)=>a.name.localeCompare(b.name));
    structures[table]={columns,indexes,foreignKeys:plain(db.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all())};
    content[table]=fingerprint(db,table,columns);
    if(table!=='d1_migrations')counts[table]=content[table].rows;
  }
  const ledger=tableNames.includes('d1_migrations')?plain(db.prepare('SELECT id,name,applied_at FROM d1_migrations ORDER BY id').all()):[];
  // sqlite_sequence affects future AUTOINCREMENT IDs. It is NOT a platform table.
  const sequence=objects.some(x=>x.name==='sqlite_sequence')?
    plain(db.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name').all()).filter(x=>!platformTable(x.name)):[];
  return {metadata:{schema,ledger,counts},structures,content,sequence,
    quickCheck:db.prepare('PRAGMA quick_check').get().quick_check,
    foreignKeyViolations:db.prepare('PRAGMA foreign_key_check').all().length};
}

export function compareSnapshots(expected,actual) {
  const metadata=compareMetadata(expected.metadata,actual.metadata),tables=[];
  for(const table of new Set([...Object.keys(expected.content),...Object.keys(actual.content)])){
    const a=expected.content[table],b=actual.content[table];
    tables.push({table,exportRows:a?.rows??null,restoredRows:b?.rows??null,
      allColumnValuesEqual:!!a&&!!b&&a.rows===b.rows&&a.digest===b.digest,
      constraintsAndIndexesEqual:same(expected.structures[table],actual.structures[table])});
  }
  const sequenceEqual=same(expected.sequence,actual.sequence);
  const checks={quickCheck:actual.quickCheck==='ok',foreignKeys:actual.foreignKeyViolations===0,sequenceEqual};
  return {status:metadata.equal&&tables.every(x=>x.allColumnValuesEqual&&x.constraintsAndIndexesEqual)&&
    Object.values(checks).every(Boolean)?'PASS':'FAIL',metadata,tables,checks};
}

export async function readExportSnapshot(folder) {
  const manifest=JSON.parse(await readFile(path.join(folder,'manifest.json'),'utf8'));
  const bytes=await readFile(path.join(folder,'work-notice-db.sql'));
  const sidecar=(await readFile(path.join(folder,'work-notice-db.sql.sha256'),'utf8')).trim().split(/\s+/)[0];
  if(!/^[a-f0-9]{64}$/i.test(manifest.sqlSha256??'')||hash(bytes)!==manifest.sqlSha256||sidecar!==manifest.sqlSha256)
    throw new Error('Backup SQL SHA-256 differs; STOP');
  const db=openSqlSnapshot(bytes.toString('utf8'));
  try{return {manifest,snapshot:inspectSnapshot(db),sqlSha256:manifest.sqlSha256};}
  catch{throw new Error('Cannot inspect SQL snapshot; details withheld');}finally{db.close();}
}

export async function findLocalDatabase(folder,manifest) {
  const config=JSON.parse(await readFile(path.join(folder,'restore-check.json'),'utf8'));
  const bindings=config.d1_databases;
  if(bindings?.length!==1||bindings[0].binding!=='DB'||bindings[0].remote!==false||
    !bindings[0].database_name?.startsWith('backup-local-')||bindings[0].database_id===manifest.preflight?.databaseId)
    throw new Error('Existing local restore configuration is not isolated; STOP');
  const root=path.join(folder,'state','v3','d1'),files=[];
  async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){
    const p=path.join(dir,e.name);if(e.isDirectory())await walk(p);
    else if(e.name.endsWith('.sqlite')&&e.name!=='metadata.sqlite')files.push(p);
  }}
  await walk(root);
  const candidates=[];
  for(const file of files){let db;try{
    db=new DatabaseSync(file,{readOnly:true,enableLoadExtension:false});
    const names=new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(x=>x.name));
    if(['d1_migrations','android_devices','push_jobs','request_nonces'].every(x=>names.has(x)))candidates.push(file);
  }catch{}finally{db?.close();}}
  if(candidates.length!==1)throw new Error('Cannot uniquely identify existing local restored D1; STOP');
  return candidates[0];
}

function validRecordedMetadata(value) {
  return Array.isArray(value)&&value.length===3&&value.every(x=>x.success&&Array.isArray(x.results))&&
    value[0].results.every(x=>Number.isInteger(x.id)&&/^\d{4}_[a-z0-9_]+\.sql$/.test(x.name))&&
    value[1].results.every(x=>['table','index','trigger','view'].includes(x.type)&&typeof x.name==='string'&&typeof x.sql==='string')&&
    value[2].results.length===1&&Object.values(value[2].results[0]).every(x=>Number.isSafeInteger(x)&&x>=0);
}

export async function recoverPreflight(folder,manifest) {
  // New backups persist metadata directly. Old backups can recover this specific
  // SELECT's JSON from private CLI logs; no raw log, URL or other JSON is emitted.
  const persisted=await readFile(path.join(folder,'metadata-pre-export.json'),'utf8').then(JSON.parse,()=>null);
  if(persisted)return {metadata:persisted,source:'metadata-pre-export.json'};
  const completed=manifest.steps?.find(x=>x.label==='SELECT migrations/schema/counts')?.completedAt;
  if(!completed)return null;
  const logDir=path.join(folder,'private-cli-logs');let files;
  try{files=await readdir(logDir);}catch{return null;}
  const candidates=[];
  for(const file of files.filter(x=>x.endsWith('.log'))){
    const raw=await readFile(path.join(logDir,file),'utf8');
    for(const block of raw.matchAll(/^--- ([^\r\n]+) (?:log|debug|info)\r?\n([\s\S]*?)^---\s*$/gm)){
      if(!Number.isFinite(Date.parse(block[1]))||Date.parse(block[1])>Date.parse(completed))continue;
      let value;try{value=JSON.parse(block[2].trim());}catch{continue;}
      if(!validRecordedMetadata(value))continue;
      const metadata={ledger:value[0].results,schema:value[1].results,counts:value[2].results[0]};
      if(same(metadata.ledger,manifest.preflight?.ledger)&&same(metadata.counts,manifest.preflight?.counts))
        candidates.push({metadata,source:file});
    }
  }
  if(!candidates.length)return null;
  if(candidates.some(x=>!same(x.metadata,candidates[0].metadata)))throw new Error('Ambiguous recorded preflight metadata; STOP');
  return candidates[0];
}

export async function verifyExistingBackup(folder,{preflight}={}) {
  const {manifest,snapshot:expected,sqlSha256}=await readExportSnapshot(folder);
  const file=await findLocalDatabase(folder,manifest);
  const db=new DatabaseSync(file,{readOnly:true,enableLoadExtension:false});let actual;
  try{actual=inspectSnapshot(db);}catch{throw new Error('Cannot inspect existing local D1; details withheld');}finally{db.close();}
  const restored=compareSnapshots(expected,actual);
  const recorded=preflight?{metadata:preflight,source:'current-run recorded SELECT'}:await recoverPreflight(folder,manifest);
  const before=recorded?.metadata;
  return {sqlSha256,restoreValidation:restored,preflightSource:recorded?.source??null,
    preflightVsExport:before?compareMetadata(before,expected.metadata):null,
    preflightVsRestored:before?compareMetadata(before,actual.metadata):null,
    missingEvidence:before?[]:['Original full pre-export metadata unavailable'],
    originalStageStatus:manifest.status,hasTimeTravelBookmark:!!manifest.bookmark,
    timeline:{preflightCompleted:manifest.steps?.find(x=>x.label==='SELECT migrations/schema/counts')?.completedAt??null,
      exportCompleted:manifest.steps?.find(x=>x.label==='EXPORT production SQL')?.completedAt??null,
      restoreCompleted:manifest.steps?.find(x=>x.label==='LOCAL restore exact SQL')?.completedAt??null},
    stageOneComplete:false};
}
