import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Test artifact only: no Wrangler deployment command, credentials, vars or network.
await build({
  absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  entryPoints: ['src/index.ts'],
  outfile: '.build/worker/index.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  conditions: ['workerd', 'worker', 'browser'],
  external: ['cloudflare:*'],
  logLevel: 'warning'
});
console.log('PASS: bundled test Worker locally with esbuild; no deploy command.');
