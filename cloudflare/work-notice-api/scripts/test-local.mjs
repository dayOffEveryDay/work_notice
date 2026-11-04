import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { queryLocal, runLocal } from './wrangler-local.mjs';

const directory = fileURLToPath(new URL('..', import.meta.url));
const state = `.wrangler/smoke-tests/${randomUUID()}`;
await runLocal(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state]);
const server = net.createServer();
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const child = spawn(process.execPath, [wrangler, 'dev', '--local', '--persist-to', state, '--ip', '127.0.0.1', '--port', String(port)], {
  cwd: directory, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false', BROWSER: 'none' }, windowsHide: true
});
let logs = '';
let exit;
const completed = new Promise(resolve => child.once('exit', (code, signal) => { exit = { code, signal }; resolve(); }));
child.stdout.on('data', data => { logs = (logs + data).slice(-16000); });
child.stderr.on('data', data => { logs = (logs + data).slice(-16000); });
child.on('error', error => { logs += String(error); });

try {
  let response;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (exit) throw new Error(`Wrangler exited: ${JSON.stringify(exit)}\n${logs}`);
    try {
      response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
      break;
    } catch { await delay(250); }
  }
  assert.ok(response, `Local Worker did not start\n${logs}`);
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { status: 'ok' });
  const probe = await queryLocal('SELECT 1 AS ok', state);
  assert.deepEqual(probe[0].results, [{ ok: 1 }]);
  const unsupported = await fetch(`http://127.0.0.1:${port}/api/alert`);
  assert.equal(unsupported.status, 404);
  await queryLocal("INSERT INTO agents(device_id,reported_mode,listener_status,notification_permission,telegram_source_confirmed,last_seen_at_ms,created_at_ms,updated_at_ms) VALUES ('cron-smoke','MONITORING','READY','ALLOWED',1,1,1,1)", state);
  for (let attempt = 0; attempt < 2; attempt++) {
    const scheduled = await fetch(`http://127.0.0.1:${port}/cdn-cgi/local/scheduled?format=json`);
    assert.equal(scheduled.status, 200, await scheduled.clone().text());
  }
  const transitions = await queryLocal("SELECT status,count(*) AS count FROM agent_status_transitions WHERE device_id='cron-smoke' GROUP BY status", state);
  assert.deepEqual(transitions[0].results, [{ status: 'OFFLINE', count: 1 }]);
  console.log('PASS: real Wrangler local /api/health, D1 SELECT 1 and scheduled() invocation twice -> one OFFLINE transition; no remote calls requested.');
} finally {
  child.kill();
  await Promise.race([completed, delay(5000)]);
}
