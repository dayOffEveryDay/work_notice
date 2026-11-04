import { eligibleJob, type Monitoring } from './monitoring.js';
import type { Env } from './index.js';
import { digest, protectToken, randomToken } from './mobile.js';
import { PushFailure, fcmCode, oauthCode, networkFailure, logPushFailure } from './push-errors.js';
const encoder = new TextEncoder();
const base64url = (s: string) => btoa(s).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const encodeJson = (value: unknown) => base64url(String.fromCharCode(...encoder.encode(JSON.stringify(value))));
type Transport = typeof fetch;
interface CachedToken { key: string; value: string; expires: number; }
export class FcmSender {
  private cache?: CachedToken;
  // Workers' native fetch requires the global receiver. Never store it directly
  // and call it as this.transport(): Node mocks do not expose that runtime bug.
  constructor(private transport: Transport = (input, init) => globalThis.fetch(input, init)) { }
  private async access(env: Env, now: number, force = false): Promise<string> {
    const cacheKey = await digest(env.FCM_SERVICE_ACCOUNT_JSON!);
    if (!force && this.cache?.key === cacheKey && this.cache.expires > now + 60000) return this.cache.value;
    let sa: { client_email: string; private_key: string; project_id: string; type: string };
    try { sa = JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON!.trim()); }
    catch { throw new PushFailure('SERVICE_ACCOUNT', 'INVALID_JSON', null, false); }
    if (!sa || typeof sa !== 'object' || sa.type !== 'service_account' || typeof sa.client_email !== 'string' || !sa.client_email || typeof sa.private_key !== 'string')
      throw new PushFailure('SERVICE_ACCOUNT', 'INVALID_FIELDS', null, false);
    if (sa.project_id !== env.FCM_PROJECT_ID) throw new PushFailure('SERVICE_ACCOUNT', 'PROJECT_MISMATCH', null, false);
    const unsigned = encodeJson({ alg: 'RS256', typ: 'JWT' }) + '.' + encodeJson({ iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 3600 });
    let key: CryptoKey;
    try {
      const pem = sa.private_key.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').trim();
      if (!pem.startsWith('-----BEGIN PRIVATE KEY-----') || !pem.endsWith('-----END PRIVATE KEY-----')) throw new Error();
      const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, '')), s => s.charCodeAt(0));
      key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    } catch { throw new PushFailure('JWT_IMPORT', 'INVALID_PKCS8_KEY', null, false); }
    let signature: Uint8Array;
    try { signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(unsigned))); }
    catch { throw new PushFailure('JWT_SIGN', 'SIGN_FAILED', null, false); }
    let response: Response;
    try {
      response = await this.transport('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + base64url(String.fromCharCode(...signature)) }).toString() });
    } catch (error) { throw networkFailure('OAUTH_NETWORK', error); }
    const result = await response.json().catch(() => null) as { access_token?: unknown; expires_in?: unknown } | null;
    if (!response.ok) throw new PushFailure('OAUTH_HTTP', oauthCode(result), response.status, response.status === 408 || response.status === 429 || response.status >= 500);
    if (!result || typeof result.access_token !== 'string' || !result.access_token || typeof result.expires_in !== 'number' || !Number.isFinite(result.expires_in) || result.expires_in <= 60)
      throw new PushFailure('OAUTH_RESPONSE', 'INVALID_TOKEN_RESPONSE', response.status);
    this.cache = { key: cacheKey, value: result.access_token, expires: now + Math.min(result.expires_in, 3600) * 1000 };
    return result.access_token;
  }
  async send(env: Env, token: string, data: Record<string, string>, ttl: number, now: number, report: (failure: PushFailure) => void = () => {}, beforeSend?:()=>Promise<boolean>): Promise<'CANCELLED'|'SENT_TO_FCM' | 'UNREGISTERED' | 'RETRY' | 'PERMANENT_FAILURE'> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const access = await this.access(env, now, attempt === 1);
      if(beforeSend&&!await beforeSend())return 'CANCELLED';
      let response: Response;
      try { response = await this.transport(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(env.FCM_PROJECT_ID!)}/messages:send`, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { token, data, android: { priority: 'HIGH', ttl: `${Math.max(1, Math.min(120, ttl))}s` } } }) }); }
      catch (error) { throw networkFailure('FCM_NETWORK', error); }
      const body = await response.json().catch(() => null) as { name?: unknown } | null;
      if (response.ok) {
        if (!body || typeof body.name !== 'string' || !body.name) throw new PushFailure('FCM_RESPONSE', 'INVALID_SEND_RESPONSE', response.status);
        return 'SENT_TO_FCM';
      }
      const code = fcmCode(body);
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      report(new PushFailure('FCM_HTTP', code, response.status, retryable || (response.status === 401 && attempt === 0)));
      if (response.status === 401 && attempt === 0) continue;
      if (code === 'UNREGISTERED') return 'UNREGISTERED';
      return retryable ? 'RETRY' : 'PERMANENT_FAILURE';
    }
    return 'PERMANENT_FAILURE';
  }
}
const sender = new FcmSender();
interface Job { id: number; mobile_id: string; device_id: string; event_id: string; push_type: string; created_at_ms: number; expires_at_ms: number; attempts: number; monitoring_session_id?: string|null; monitoring_revision?: number|null; occurred_at_ms?: number|null; }
export async function dispatchPush(env: Env, now = Date.now(), client = sender): Promise<void> {
  const db = env.DB;
  await db.prepare("UPDATE push_jobs SET state='EXPIRED',last_error=COALESCE(last_error,'TTL_EXPIRED') WHERE state IN ('PENDING','RETRY') AND expires_at_ms<=?").bind(now).run();
  const lease = randomToken();
  const jobs = await db.prepare(`UPDATE push_jobs SET lease_id=?,lease_until_ms=?,attempts=attempts+1
    WHERE id IN (SELECT id FROM push_jobs WHERE state IN ('PENDING','RETRY') AND expires_at_ms>? AND next_attempt_ms<=? AND lease_until_ms<=? AND attempts<5 ORDER BY id LIMIT 20) RETURNING *`)
    .bind(lease, now + 60000, now, now, now).all<Job>();
  // Parallel requests bound runtime to the lease; each send has strict timeouts.
  await Promise.all(jobs.results.map(async job => {
    const mobile = await db.prepare('SELECT fcm_cipher,fcm_version FROM android_devices WHERE mobile_id=? AND revoked_at_ms IS NULL').bind(job.mobile_id).first<{ fcm_cipher: string | null; fcm_version: number }>();
    let state = 'PERMANENT_FAILURE', error: string | null = 'REVOKED_OR_NO_TOKEN';
    let failure: PushFailure | undefined;
    if (mobile?.fcm_cipher) {
      const setting = await db.prepare('SELECT enabled,mode,expires_at_ms FROM alert_settings WHERE device_id=?').bind(job.device_id).first<{ enabled: number; mode: string; expires_at_ms: number | null }>();
      const monitoring=await db.prepare('SELECT * FROM monitoring_settings WHERE device_id=?').bind(job.device_id).first<Monitoring>();
      const permitted=monitoring?eligibleJob(monitoring,job,now):!job.monitoring_session_id;
      const enabled = setting?.enabled && (setting.mode !== 'TIMED' || (setting.expires_at_ms ?? 0) > now);
      if (job.push_type === 'WORK_ALERT' && (!permitted||(!monitoring&&!enabled))) { state = 'EXPIRED'; error = 'DISABLED'; }
      else if (!env.FCM_PROJECT_ID || !env.FCM_SERVICE_ACCOUNT_JSON || !env.FCM_TOKEN_ENCRYPTION_KEY) { state = 'PENDING'; error = 'NOT_CONFIGURED'; }
      else {
        try {
          let token: string;
          try { token = await protectToken(env, mobile.fcm_cipher, true); }
          catch { throw new PushFailure('TOKEN_DECRYPT', 'DECRYPT_FAILED', null, false); }
          state = await client.send(env, token, { type: job.push_type, eventId: job.event_id,
            issuedAt: new Date(job.created_at_ms).toISOString(), expiresAt: new Date(job.expires_at_ms).toISOString(),
            ...(monitoring&&job.push_type==='WORK_ALERT'?{monitoringSessionId:monitoring.session_id,monitoringRevision:String(monitoring.revision),monitoringStartsAtMs:String(monitoring.starts_at_ms),monitoringMode:monitoring.mode,monitoringCommandId:monitoring.last_command_id,occurredAt:new Date(job.occurred_at_ms!).toISOString(),serverNowMs:String(now)}:{}) }, Math.ceil((job.expires_at_ms - now) / 1000), now, detail => { failure = detail; logPushFailure(detail, job.id, job.attempts, 'ATTEMPT'); },async()=>{
            if(job.push_type!=='WORK_ALERT')return true;
            const latest=await db.prepare('SELECT * FROM monitoring_settings WHERE device_id=?').bind(job.device_id).first<Monitoring>();
            return latest?eligibleJob(latest,job,Math.max(now,Date.now()))&&job.expires_at_ms>Math.max(now,Date.now()):!job.monitoring_session_id;
          });
          if(state==='CANCELLED'){state='EXPIRED';error='MONITORING_REPLACED';}
          error = state === 'SENT_TO_FCM' ? null : error==='MONITORING_REPLACED'?error:failure?.message ?? state;
          if (state === 'UNREGISTERED') {
            await db.prepare('UPDATE android_devices SET fcm_cipher=NULL,updated_at_ms=? WHERE mobile_id=? AND fcm_version=?').bind(now, job.mobile_id, mobile.fcm_version).run();
            state = 'PERMANENT_FAILURE';
          }
        } catch (caught) {
          failure = caught instanceof PushFailure ? caught : new PushFailure('DISPATCH', 'UNEXPECTED_FAILURE');
          state = failure.retryable ? 'RETRY' : 'PERMANENT_FAILURE'; error = failure.message;
          logPushFailure(failure, job.id, job.attempts, state);
        }
      }
    }
    if (job.attempts >= 5 && (state === 'RETRY' || state === 'PENDING')) { state = 'PERMANENT_FAILURE'; error ??= 'ATTEMPTS_EXHAUSTED'; }
    await db.prepare(`UPDATE push_jobs SET state=?,last_error=?,next_attempt_ms=?,lease_until_ms=0,lease_id=NULL,sent_at_ms=? WHERE id=? AND lease_id=? AND state IN ('PENDING','RETRY')`)
      .bind(state, error, now + Math.min(60000, 5000 * 2 ** Math.min(job.attempts, 4)), state === 'SENT_TO_FCM' ? now : null, job.id, lease).run();
  }));
}
export async function cleanupMobile(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM mobile_pairings WHERE expires_at_ms<?').bind(now - 86400000),
    db.prepare('DELETE FROM mobile_rate_limits WHERE window_ms<?').bind(now - 600000),
    db.prepare('DELETE FROM mobile_acks WHERE received_at_ms<?').bind(now - 7 * 86400000),
    db.prepare('DELETE FROM push_jobs WHERE expires_at_ms<?').bind(now - 7 * 86400000)
  ]);
}
