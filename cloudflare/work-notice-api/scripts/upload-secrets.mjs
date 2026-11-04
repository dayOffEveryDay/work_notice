// Explicitly invoked by the user after reviewing deployment instructions. No deployment or DB operations.
import { spawn } from 'node:child_process';
import { wranglerPath, projectDirectory } from './wrangler-local.mjs';
import { loadLocalSecrets } from './local-secrets.mjs';

const keys = await loadLocalSecrets();
for (const [name, value] of keys) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wranglerPath, 'secret', 'put', name], {
      cwd: projectDirectory, windowsHide: true, stdio: ['pipe', 'inherit', 'inherit'],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }
    });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Secret upload failed for ${name}`)));
    child.stdin.end(value);
  });
}
