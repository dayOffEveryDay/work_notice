import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const run = promisify(execFile);
export const projectDirectory = fileURLToPath(new URL('../', import.meta.url));
export const wranglerPath = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));

export async function runLocal(args) {
  if (args[0] !== 'd1' || args.some(arg => /^--(?:remote|preview)(?:=|$)/.test(arg)) || !args.includes('--local'))
    throw new Error('Only explicit local D1 commands are allowed');
  const env = { ...process.env };
  // Local tests have no reason to load the operator's Cloudflare account/session.
  for (const key of Object.keys(env)) if (/^(?:CLOUDFLARE_|CF_)/.test(key)) delete env[key];
  Object.assign(env, { WRANGLER_SEND_METRICS: 'false', BROWSER: 'none',
    XDG_CONFIG_HOME: path.join(projectDirectory, '.wrangler', 'local-test-config'),
    WRANGLER_LOG_PATH: path.join(projectDirectory, '.wrangler', 'local-test-logs') });
  return run(process.execPath, [wranglerPath, ...args], {
    cwd: projectDirectory, windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024,
    env
  });
}

export async function queryLocal(sql, persistTo = '.wrangler/test-state') {
  const { stdout } = await runLocal(['d1', 'execute', 'DB', '--local', '--persist-to', persistTo, '--json', '--command', sql]);
  const result = JSON.parse(stdout);
  if (result.some(entry => !entry.success)) throw new Error('Local D1 query failed');
  return result;
}
