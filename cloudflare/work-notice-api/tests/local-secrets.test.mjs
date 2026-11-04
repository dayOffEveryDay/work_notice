import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { parseLocalSecrets } from '../scripts/local-secrets.mjs';

test('secret parser accepts generated LF and Windows CRLF without printing values', () => {
  const agent = randomBytes(32).toString('hex'), admin = randomBytes(32).toString('hex');
  for (const newline of ['\n', '\r\n']) {
    const parsed = parseLocalSecrets(`AGENT_HMAC_SECRET=${agent}${newline}ADMIN_API_KEY=${admin}${newline}`);
    assert.equal(parsed.get('AGENT_HMAC_SECRET'), agent);
    assert.equal(parsed.get('ADMIN_API_KEY'), admin);
  }
});
test('secret parser rejects shared keys', () => {
  const value = randomBytes(32).toString('hex');
  assert.throws(() => parseLocalSecrets(`AGENT_HMAC_SECRET=${value}\nADMIN_API_KEY=${value}`), /independent/);
});
test('secret parser rejects duplicate or malformed entries', () => {
  const a = randomBytes(32).toString('hex'), b = randomBytes(32).toString('hex');
  assert.throws(() => parseLocalSecrets(`AGENT_HMAC_SECRET=${a}\nAGENT_HMAC_SECRET=${a}\nADMIN_API_KEY=${b}`));
  assert.throws(() => parseLocalSecrets('AGENT_HMAC_SECRET=too-short\nADMIN_API_KEY=too-short'));
});
