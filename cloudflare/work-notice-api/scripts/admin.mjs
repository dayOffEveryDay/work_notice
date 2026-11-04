// Manual admin client. It is never invoked by tests or deployment scripts.
import { loadLocalSecrets } from './local-secrets.mjs';

const [action, ...arguments_] = process.argv.slice(2);
if (!['status', 'settings'].includes(action) || arguments_.length % 2) throw new Error('Usage: node scripts/admin.mjs status|settings [--endpoint URL] [--device ID] [--enabled true|false --mode TIMED|UNTIL_MANUALLY_DISABLED --minutes N]');
const flags = new Map();
for (let i = 0; i < arguments_.length; i += 2) {
  if (!['--endpoint', '--device', '--enabled', '--mode', '--minutes'].includes(arguments_[i]) || flags.has(arguments_[i])) throw new Error('Unknown or duplicate argument');
  flags.set(arguments_[i], arguments_[i + 1]);
}
const endpoint = new URL(flags.get('--endpoint') ?? 'https://work-notice-api.hui760419.workers.dev');
if (endpoint.protocol !== 'https:' || endpoint.pathname !== '/' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) throw new Error('HTTPS origin required');
const deviceId = flags.get('--device') ?? 'home-windows';
if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(deviceId)) throw new Error('Invalid device ID');
const keys = await loadLocalSecrets();
let path = '/api/device/status?deviceId=' + encodeURIComponent(deviceId);
let body;
if (action === 'settings') {
  if (!['true', 'false'].includes(flags.get('--enabled'))) throw new Error('--enabled true|false is required');
  const mode = flags.get('--mode') ?? 'UNTIL_MANUALLY_DISABLED';
  if (!['TIMED', 'UNTIL_MANUALLY_DISABLED'].includes(mode)) throw new Error('Invalid mode');
  const enabled = flags.get('--enabled') === 'true';
  body = { deviceId, enabled, mode };
  if (enabled && mode === 'TIMED') {
    const minutes = Number(flags.get('--minutes'));
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) throw new Error('TIMED requires --minutes 1..10080');
    body.durationMinutes = minutes;
  }
  path = '/api/device/settings';
}
const response = await fetch(endpoint.origin + path, {
  method: action === 'status' ? 'GET' : 'PUT',
  headers: { Authorization: 'Bearer ' + keys.get('ADMIN_API_KEY'), 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(10000)
});
console.log(JSON.stringify(await response.json(), null, 2));
if (!response.ok) process.exitCode = 1;
