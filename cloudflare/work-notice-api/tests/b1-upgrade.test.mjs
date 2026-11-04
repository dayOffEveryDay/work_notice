import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { protectToken } from '../.build/mobile.js';
import { dispatchPush } from '../.build/fcm.js';
import { projectDirectory } from '../scripts/wrangler-local.mjs';
import { UpgradeFixture, legacyTables, migrationFiles, migrationHashes, legacyHash, sha256, normalizedSql, snapshot } from './helpers/b1-fixture.mjs';

test('B1: persisted populated D1 0002 -> 0004, legacy Worker and current Worker', { timeout: 180000 }, async t => {
  const f = new UpgradeFixture();
  const report = { runId: f.id, checks: [], integrity: [], warnings: [], localOnly: true, realPushes: 0,
    legacyFixtureSha256: legacyHash, legacyFixtureProvenance: 'Local Wrangler dev bundle, 2026-11-02T15:33:34.619Z; not a byte-for-byte attestation of the deployed Cloudflare version.' };
  const check = async (name, fn) => t.test(name, async () => {
    try { await fn(); report.checks.push({ name, status: 'PASS' }); }
    catch (error) { report.checks.push({ name, status: 'FAIL' }); throw error; }
  });
  const oldColumns = (name, row) => Object.fromEntries(f.before[name].columns.map(c => [c.name, row[c.name]]));
  const setting = c => f.db.prepare('SELECT * FROM alert_settings WHERE device_id=?').bind(c.id).first();
  const eventRow = id => f.db.prepare('SELECT * FROM alert_events WHERE event_id=?').bind(id).first();
  const jobFor = id => f.db.prepare('SELECT * FROM push_jobs WHERE event_id=?').bind(id).first();
  const always = f.cases[1];
  let immediateCommand, immediate, scheduled;
  try {
    await f.setup0002();

    await check('actual local ledger starts at 0002 and adds 0003 and 0004 on the same persisted D1', async () => {
      assert.deepEqual(f.beforeLedger.map(x => x.name), migrationFiles.slice(0, 2));
      assert.deepEqual(f.afterLedger.map(x => x.name), migrationFiles);
      assert.deepEqual(f.afterLedger.slice(0, 2), f.beforeLedger);
      assert.equal(f.before.push_jobs.columns.some(x => x.name === 'monitoring_session_id'), false);
      for (const [i, file] of migrationFiles.entries()) {
        assert.equal(sha256(await readFile(path.join(projectDirectory, 'migrations', file))), migrationHashes[i]);
      }
    });

    await check('all ten legacy tables retain every row and every preexisting column value', async () => {
      for (const table of legacyTables) {
        const before = f.before[table].rows, after = f.after[table].rows.map(row => oldColumns(table, row));
        assert.deepEqual(after, before, table);
        report.integrity.push({ table, before: before.length, after: after.length,
          beforeSha256: sha256(JSON.stringify(before)), afterSha256: sha256(JSON.stringify(after)), equal: true });
      }
      assert.ok(f.before.push_jobs.rows.some(x => x.state === 'PENDING'));
      assert.ok(f.before.push_jobs.rows.some(x => x.state === 'RETRY'));
      assert.deepEqual(new Set(f.before.mobile_acks.rows.map(x => x.status)), new Set(['RECEIVED','RINGING','STOPPED','NOTIFICATION_FALLBACK']));
    });

    await check('legacy column definitions, primary keys, indexes, partial uniqueness and foreign keys survive', async () => {
      for (const table of legacyTables) {
        const a = f.before[table], b = f.after[table];
        assert.deepEqual(b.columns.slice(0, a.columns.length), a.columns, table + ' columns');
        assert.deepEqual(b.primaryKey, a.primaryKey, table + ' primary key');
        assert.deepEqual(b.indexes, a.indexes, table + ' indexes');
        assert.deepEqual(b.foreignKeys, a.foreignKeys, table + ' foreign keys');
        if (!['push_jobs','agents'].includes(table)) assert.equal(b.sql, a.sql, table + ' CREATE TABLE');
        else for (const constraint of a.sql.match(/CHECK\s*\([^;]*?\)\)/g) ?? []) assert.ok(b.sql.includes(constraint));
      }
    });

    await check('encrypted FCM bytes, bearer hashes, versions and authenticated decryption are preserved', async () => {
      assert.deepEqual(f.after.android_devices.rows, f.before.android_devices.rows);
      for (const c of f.cases) {
        const row = f.after.android_devices.rows.find(x => x.mobile_id === c.mobile);
        assert.equal(row.fcm_cipher, c.cipher);
        assert.equal(await protectToken(f.env, row.fcm_cipher, true), 'b1-synthetic-fcm-' + c.id);
        await assert.rejects(() => protectToken({ ...f.env, FCM_TOKEN_ENCRYPTION_KEY: '0'.repeat(64) }, row.fcm_cipher, true));
      }
    });

    await check('three nullable push columns are added without backfilling or cancelling old jobs', async () => {
      const columns = f.after.push_jobs.columns.slice(f.before.push_jobs.columns.length);
      assert.deepEqual(columns.map(c => [c.name,c.type,c.notnull,c.dflt_value,c.pk]), [
        ['monitoring_session_id','TEXT',0,null,0], ['monitoring_revision','INTEGER',0,null,0], ['occurred_at_ms','INTEGER',0,null,0]
      ]);
      for (const job of f.after.push_jobs.rows) {
        assert.equal(job.monitoring_session_id, null);
        assert.equal(job.monitoring_revision, null);
        assert.equal(job.occurred_at_ms, null);
      }
    });

    await check('new empty tables and all six exact trigger definitions match the migrations', async () => {
      for (const name of ['monitoring_settings','monitoring_commands']) {
        assert.ok(await f.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name=?").bind(name).first());
        assert.equal((await f.db.prepare(`SELECT count(*) n FROM ${name}`).first()).n, 0);
      }
      const expected = new Map();
      for (const file of migrationFiles.slice(1)) {
        const sql = await readFile(path.join(projectDirectory,'migrations',file),'utf8');
        for (const match of sql.matchAll(/CREATE TRIGGER (\w+)[\s\S]*?^END;/gm)) expected.set(match[1], normalizedSql(match[0]));
      }
      assert.equal(expected.size, 6);
      assert.deepEqual(f.afterTriggers.map(x => x.name), [...expected.keys()].sort());
      for (const trigger of f.afterTriggers) assert.equal(normalizedSql(trigger.sql), expected.get(trigger.name), trigger.name);
      for (const name of ['cancel_disabled_pushes','enqueue_mobile_offline']) {
        assert.deepEqual(f.afterTriggers.find(x => x.name === name), f.beforeTriggers.find(x => x.name === name));
      }
    });

    await check('old primary/unique/NOT NULL/CHECK constraints and new mode/revision checks still reject invalid rows', async () => {
      const invalid = [
        "INSERT INTO agents(device_id,created_at_ms,updated_at_ms) VALUES ('b1-off',1,1)",
        "INSERT INTO agents(device_id,created_at_ms,updated_at_ms) VALUES ('missing-time',NULL,1)",
        "UPDATE alert_settings SET enabled=2 WHERE device_id='b1-off'",
        "UPDATE android_devices SET offline_alerts=2 WHERE mobile_id='mobile-b1-off'",
        "INSERT INTO android_devices(mobile_id,device_id,bearer_hash,created_at_ms,updated_at_ms) VALUES ('duplicate-active','b1-always','synthetic-unique-hash',1,1)",
        "INSERT INTO request_nonces SELECT * FROM request_nonces LIMIT 1",
        "INSERT INTO mobile_pairings SELECT * FROM mobile_pairings LIMIT 1",
        "INSERT INTO mobile_acks SELECT * FROM mobile_acks LIMIT 1",
        "UPDATE mobile_acks SET status='INVALID' WHERE mobile_id='mobile-b1-off'",
        "UPDATE push_jobs SET state='INVALID' WHERE device_id='b1-off'",
        "INSERT INTO push_jobs(device_id,mobile_id,event_id,push_type,created_at_ms,expires_at_ms,next_attempt_ms) SELECT device_id,mobile_id,event_id,push_type,created_at_ms,expires_at_ms,next_attempt_ms FROM push_jobs LIMIT 1"
      ];
      for (const sql of invalid) await assert.rejects(() => f.db.prepare(sql).run(), /constraint|NOT NULL/i);
      for (const [mode, revision, consent] of [['BAD',1,1],['OFF',0,0],['OFF',1,2]]) {
        await assert.rejects(() => f.db.prepare('INSERT INTO monitoring_settings VALUES (?,?,?,?,?,?,?,?,?)')
          .bind('invalid-monitor','mobile-b1-off',mode,null,'synthetic-session',revision,consent,'synthetic-command',f.now).run(), /constraint/i);
      }
      assert.deepEqual(await snapshot(f.db), f.after, 'failed constraint probes must not alter stored data');
    });

    await check('new GET default OFF does not adopt a session or disable any legacy setting', async () => {
      for (const c of f.cases) {
        const root = await (await f.call('current',c,'/api/mobile/monitoring')).json();
        assert.equal(root.monitoring.mode,'OFF'); assert.equal(root.monitoring.revision,0);
        const status = await (await f.call('current',c,'/api/mobile/status')).json();
        assert.equal(status.fcmRegistered,true);
        assert.equal(status.alertSetting.effectiveEnabled,!!c.enabled && (c.expiry === null || c.expiry > f.now));
      }
      assert.equal((await f.db.prepare('SELECT count(*) n FROM monitoring_settings').first()).n,0);
      assert.deepEqual(await snapshot(f.db),f.after);
    });

    await check('frozen old Worker can read OFF, ALWAYS and active/expired TIMED under schema 0003', async () => {
      for (const c of f.cases) {
        const response = await f.call('legacy',c,'/api/mobile/status'); assert.equal(response.status,200);
        const result = await response.json();
        assert.equal(result.alertSetting.mode,c.mode);
        assert.equal(result.alertSetting.effectiveEnabled,!!c.enabled && (c.expiry === null || c.expiry > f.now));
        assert.equal(result.fcmRegistered,true); assert.equal(result.monitoring,undefined);
      }
    });

    await check('both old and current legacy PUT support OFF, ALWAYS and TIMED before adoption', async () => {
      const c=f.cases[0];
      for (const worker of ['legacy','current']) {
        for (const body of [
          {enabled:true,mode:'UNTIL_MANUALLY_DISABLED'},
          {enabled:true,mode:'TIMED',durationMinutes:30},
          {enabled:false,mode:'UNTIL_MANUALLY_DISABLED'}
        ]) {
          const response=await f.call(worker,c,'/api/mobile/alert-settings','PUT',body); assert.equal(response.status,200);
          const row=await setting(c); assert.equal(row.enabled,body.enabled?1:0); assert.equal(row.mode,body.mode);
          assert.equal(row.expires_at_ms,body.enabled&&body.mode==='TIMED'?f.now+1800000:null);
        }
      }
      assert.equal((await f.db.prepare('SELECT count(*) n FROM monitoring_settings').first()).n,0);
    });

    await check('old Worker ingestion queues only enabled/unexpired legacy events after upgrade', async () => {
      for (const c of f.cases) {
        const {eventId}=await f.alert('legacy',c);
        const expected=c.id==='b1-always'||c.id==='b1-timed';
        assert.equal((await eventRow(eventId)).should_notify,expected?1:0);
        const job=await jobFor(eventId); assert.equal(!!job,expected);
        if(job)assert.equal(job.monitoring_session_id,null);
      }
    });

    await check('old native OAuth/FCM dispatcher decrypts existing PENDING/RETRY jobs with no real network', async () => {
      const count=f.sent.length;
      await f.dispatch('legacy');
      // Two existing ALWAYS PENDING/RETRY, one existing active TIMED, two newly ingested.
      assert.equal(f.sent.length-count,5);
      assert.ok(f.sent.slice(count).every(x=>x.worker==='legacy'&&!('monitoringSessionId' in x.data)));
      const expired=await jobFor(f.cases[3].event); assert.equal(expired.state,'EXPIRED'); assert.equal(expired.sent_at_ms,null);
      const history=await jobFor(always.event); assert.equal(history.sent_at_ms,f.started-25000);
      await f.dispatch('legacy'); assert.equal(f.sent.length-count,5,'sent jobs must not be sent again');
      assert.ok(f.oauth.includes('legacy'));
    });

    await check('current Worker retains legacy ingestion, event dedup and mock FCM without monitoring rows', async () => {
      const count=f.sent.length;
      for(const c of f.cases){
        const {eventId}=await f.alert('current',c);const expected=c.id==='b1-always'||c.id==='b1-timed';
        assert.equal((await eventRow(eventId)).should_notify,expected?1:0);
        const again=await f.alert('current',c,f.now,eventId);assert.equal((await again.response.json()).status,'DUPLICATE');
      }
      await f.dispatch('current');assert.equal(f.sent.length-count,2);
      assert.ok(f.sent.slice(count).every(x=>x.worker==='current'&&!('monitoringSessionId' in x.data)));
      assert.equal((await f.db.prepare('SELECT count(*) n FROM monitoring_settings').first()).n,0);
    });

    await check('first IMMEDIATE adoption atomically disables legacy and expires existing PENDING/RETRY', async () => {
      const tokensBefore=(await f.db.prepare('SELECT * FROM android_devices ORDER BY mobile_id').all()).results;
      const pending=await f.addJob(always,'PENDING'),retry=await f.addJob(always,'RETRY');
      f.now+=1000;immediateCommand=f.command('IMMEDIATE',0);
      const response=await f.put(always,immediateCommand);assert.equal(response.status,200);immediate=(await response.json()).monitoring;
      assert.equal(immediate.mode,'IMMEDIATE');assert.equal(immediate.state,'ACTIVE');assert.equal(immediate.revision,1);
      assert.match(immediate.session_id,/^[a-f0-9]{64}$/);assert.equal(immediate.starts_at_ms,f.now);
      assert.equal((await setting(always)).enabled,0);
      for(const id of [pending,retry])assert.equal((await jobFor(id)).state,'EXPIRED');
      assert.equal((await jobFor(always.event)).state,'SENT_TO_FCM');
      assert.deepEqual((await f.db.prepare('SELECT * FROM android_devices ORDER BY mobile_id').all()).results,tokensBefore);
      assert.equal((await f.db.prepare('SELECT applied_revision FROM monitoring_commands WHERE command_id=?').bind(immediateCommand.commandId).first()).applied_revision,1);
    });

    await check('current legacy mobile/admin writes return 409 and cannot overwrite adopted monitoring', async () => {
      const before=await f.monitoring(always);
      for(const enabled of [false,true]){
        const body={enabled,mode:'UNTIL_MANUALLY_DISABLED'};
        const mobile=await f.call('current',always,'/api/mobile/alert-settings','PUT',body);
        assert.equal(mobile.status,409);assert.equal((await mobile.json()).error,'monitoring_api_required');
        const admin=await f.call('current',always,'/api/device/settings','PUT',{deviceId:always.id,...body},f.now,true);
        assert.equal(admin.status,409);assert.equal((await admin.json()).error,'monitoring_api_required');
      }
      assert.deepEqual(await f.monitoring(always),before);
    });

    await check('old Worker rollback after adoption is schema-safe but cannot operate the new session', async () => {
      const response=await f.call('legacy',always,'/api/mobile/alert-settings','PUT',{enabled:true,mode:'UNTIL_MANUALLY_DISABLED'});
      assert.equal(response.status,500);assert.equal((await response.json()).error,'internal_error');
      assert.equal((await setting(always)).enabled,0);
      const oldEvent=await f.alert('legacy',always);assert.equal((await eventRow(oldEvent.eventId)).should_notify,0);
      assert.equal(await jobFor(oldEvent.eventId),null);
      const newEvent=await f.alert('current',always);assert.equal((await jobFor(newEvent.eventId)).monitoring_session_id,immediate.session_id);
      const count=f.sent.length;await f.dispatch('legacy');
      assert.equal(f.sent.length,count);assert.equal((await jobFor(newEvent.eventId)).state,'EXPIRED');
      assert.deepEqual(await f.monitoring(always),immediate);
      report.warnings.push('After adoption: legacy Worker setting write returns 500 from the protective trigger, drops new work through disabled legacy projection, and expires queued new-session work. Use a forward fix; code rollback does not restore new monitoring.');
    });

    await check('new-session IMMEDIATE event still traverses real worker OAuth/FCM code with session metadata', async () => {
      f.now+=1000;const {eventId}=await f.alert('current',always);const count=f.sent.length;
      await f.dispatch('current');assert.equal(f.sent.length,count+1);
      const data=f.sent.at(-1).data;assert.equal(data.eventId,eventId);
      assert.equal(data.monitoringSessionId,immediate.session_id);assert.equal(data.monitoringRevision,'1');
      assert.equal(data.monitoringCommandId,immediateCommand.commandId);assert.equal(data.monitoringMode,'IMMEDIATE');
      assert.equal(data.occurredAt,new Date(f.now).toISOString());assert.equal((await jobFor(eventId)).state,'SENT_TO_FCM');
    });

    await check('command retries preserve original session/start/revision and reject reused IDs with changed input', async () => {
      f.now+=1000;const count=(await f.db.prepare('SELECT count(*) n FROM monitoring_commands').first()).n;
      const replay=await f.put(always,immediateCommand);assert.equal(replay.status,200);assert.deepEqual((await replay.json()).monitoring,immediate);
      assert.equal((await f.db.prepare('SELECT count(*) n FROM monitoring_commands').first()).n,count);
      const reused=await f.put(always,{...immediateCommand,mode:'SCHEDULED',delayMinutes:60});
      assert.equal(reused.status,409);assert.equal((await reused.json()).error,'command_reused');
      assert.deepEqual(await f.monitoring(always),immediate);
    });

    await check('failed revision CAS records a loser without changing the winner or cancelling its job', async () => {
      const id=await f.addJob(always,'PENDING',immediate),loser=f.command('OFF',0);
      const response=await f.put(always,loser);assert.equal(response.status,409);assert.equal((await response.json()).error,'revision_conflict');
      assert.equal((await f.db.prepare('SELECT applied_revision FROM monitoring_commands WHERE command_id=?').bind(loser.commandId).first()).applied_revision,null);
      assert.equal((await jobFor(id)).state,'PENDING');assert.deepEqual(await f.monitoring(always),immediate);
    });

    await check('SCHEDULED replaces the session and never queues pre-start or delayed pre-start notifications', async () => {
      f.now+=1000;const command=f.command('SCHEDULED',1),response=await f.put(always,command);assert.equal(response.status,200);
      scheduled=(await response.json()).monitoring;assert.equal(scheduled.starts_at_ms,f.now+60000);assert.equal(scheduled.revision,2);
      assert.notEqual(scheduled.session_id,immediate.session_id);assert.equal(scheduled.state,'SCHEDULED');
      const replay=await f.put(always,command);assert.equal(replay.status,200);assert.deepEqual((await replay.json()).monitoring,scheduled);
      f.now=scheduled.starts_at_ms-1000;const before=await f.alert('current',always);assert.equal(await jobFor(before.eventId),null);
      const jobsBefore=(await f.jobs()).length,count=f.sent.length;
      f.now=scheduled.starts_at_ms;assert.equal((await f.monitoring(always)).state,'ACTIVE');
      assert.equal((await f.jobs()).length,jobsBefore);assert.equal(f.sent.length,count,'start time alone must not send anything');
      f.now+=1000;const late=await f.alert('current',always,scheduled.starts_at_ms-1000);assert.equal(await jobFor(late.eventId),null);
      assert.equal((await eventRow(late.eventId)).should_notify,0);
      await f.alert('current',always,f.now,before.eventId);assert.equal(await jobFor(before.eventId),null,'retrying pre-start event must not backfill');
    });

    await check('post-start SCHEDULED event pushes once with original period, occurrence and bounded TTL', async () => {
      const count=f.sent.length,{eventId}=await f.alert('current',always);await f.dispatch('current');
      assert.equal(f.sent.length,count+1);const data=f.sent.at(-1).data;
      assert.equal(data.eventId,eventId);assert.equal(data.monitoringSessionId,scheduled.session_id);assert.equal(data.monitoringRevision,'2');
      assert.equal(data.monitoringStartsAtMs,String(scheduled.starts_at_ms));assert.equal(data.monitoringMode,'SCHEDULED');
      assert.equal((await jobFor(eventId)).monitoring_revision,2);
      await f.alert('current',always,f.now,eventId);await f.dispatch('current');assert.equal(f.sent.length,count+1);
    });

    await check('stale session/revision outbox cannot enter the current session; expired source never queues', async () => {
      const old=await f.addJob(always,'RETRY',immediate),count=f.sent.length;
      await f.dispatch('current');assert.equal((await jobFor(old)).state,'EXPIRED');assert.equal(f.sent.length,count);
      const stale=await f.alert('current',always,f.now-120001);assert.equal((await eventRow(stale.eventId)).result,'STALE');
      assert.equal(await jobFor(stale.eventId),null);
    });

    await check('final pre-send gate rejects cancellation after initial eligibility check without resurrecting jobs', async () => {
      const {eventId}=await f.alert('current',always);let attempted=0;
      await dispatchPush(f.env,f.now,{send:async(env,token,data,ttl,now,reportFailure,gate)=>{
        attempted++;const off=await f.put(always,f.command('OFF',2));assert.equal(off.status,200);
        assert.equal(await gate(),false);return 'CANCELLED';
      }});
      assert.equal(attempted,1);assert.equal((await jobFor(eventId)).state,'EXPIRED');
      assert.equal((await f.monitoring(always)).mode,'OFF');
    });

    await check('OFF stays off, command replay does not advance revision and later events do not queue', async () => {
      const off=await f.monitoring(always);assert.equal(off.revision,3);assert.equal(off.starts_at_ms,null);
      const command=(await f.db.prepare('SELECT command_id FROM monitoring_commands WHERE applied_revision=3').first()).command_id;
      const response=await f.put(always,{commandId:command,expectedRevision:2,mode:'OFF',delayMinutes:0,urgentConsent:false});
      assert.equal(response.status,200);assert.deepEqual((await response.json()).monitoring,off);
      const {eventId}=await f.alert('current',always);assert.equal(await jobFor(eventId),null);
    });

    await check('concurrent upgraded-DB writers have exactly one CAS winner and one conflict', async () => {
      const results=await Promise.all([f.put(always,f.command('IMMEDIATE',3)),f.put(always,f.command('SCHEDULED',3))]);
      assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);
      assert.equal((await f.monitoring(always)).revision,4);
      const rows=(await f.db.prepare('SELECT applied_revision FROM monitoring_commands WHERE expected_revision=3').all()).results;
      assert.deepEqual(rows.map(x=>x.applied_revision).sort(),[4,null].sort());
    });

    await check('revocation trigger closes the adopted session and invalidates pending work', async () => {
      const monitor=await f.monitoring(always),id=await f.addJob(always,'RETRY',monitor);
      await f.db.prepare('UPDATE android_devices SET revoked_at_ms=? WHERE mobile_id=?').bind(f.now,always.mobile).run();
      const row=await f.db.prepare('SELECT * FROM monitoring_settings WHERE device_id=?').bind(always.id).first();
      assert.equal(row.mode,'OFF');assert.equal(row.revision,5);assert.equal(row.urgent_consent,0);assert.equal(row.starts_at_ms,null);
      assert.equal((await jobFor(id)).state,'EXPIRED');
    });

    await check('rerunning migrations is a no-op on this populated upgraded database', async () => {
      const tables=[...legacyTables,'monitoring_settings','monitoring_commands','d1_migrations'];
      const before=await snapshot(f.db,tables);
      await f.close();await f.migrate();await f.open();
      assert.deepEqual(await snapshot(f.db,tables),before);
    });
  } finally {
    await f.close();
    report.status=report.checks.length===27&&report.checks.every(x=>x.status==='PASS')?'PASS':'FAIL';
    report.mockOAuthRequests=f.oauth.length;report.mockFcmRequests=f.sent.length;
    await writeFile(path.join(f.artifacts,'result.json'),JSON.stringify(report,null,2));
    console.log('B1 evidence: '+f.artifacts);
  }
});
