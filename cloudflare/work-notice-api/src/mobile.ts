import { monitoringRoute, monitoringView, type Monitoring } from './monitoring.js';
import { ApiError, admin, choice, deviceId, fields, hex, object, rawBody, text } from './security.js';
import { effectiveStatus, type AgentRow } from './database.js';
import type { Env } from './index.js';
const enc = new TextEncoder();
export const digest = async (s: string) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
export const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
export interface Mobile { mobile_id: string; device_id: string; fcm_cipher: string | null; fcm_version: number; offline_alerts: number; created_at_ms: number; }
export async function protectToken(env: Env, value: string, decrypt = false): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(env.FCM_TOKEN_ENCRYPTION_KEY ?? '')) throw new ApiError(503, 'token_encryption_not_configured');
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(env.FCM_TOKEN_ENCRYPTION_KEY!.match(/../g)!, s => parseInt(s, 16)), 'AES-GCM', false, ['encrypt', 'decrypt']);
  if (decrypt) {
    const bytes = Uint8Array.from(atob(value), s => s.charCodeAt(0));
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12)));
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(value)));
  return btoa(String.fromCharCode(...iv, ...encrypted));
}
async function rateLimit(request: Request, env: Env, now: number): Promise<void> {
  const source = await digest(request.headers.get('CF-Connecting-IP') ?? 'local');
  const window = Math.floor(now / 60000) * 60000;
  const result = await env.DB.batch(['global', source].map(bucket => env.DB.prepare(`INSERT INTO mobile_rate_limits(bucket,window_ms,attempts) VALUES (?,?,1)
    ON CONFLICT(bucket,window_ms) DO UPDATE SET attempts=attempts+1 RETURNING attempts`).bind(bucket, window))) as D1Result<{ attempts: number }>[];
  if (Number(result[0].results[0].attempts) > 100 || Number(result[1].results[0].attempts) > 10) throw new ApiError(429, 'pairing_rate_limited');
}
export async function authenticateMobile(request: Request, env: Env): Promise<Mobile> {
  const bearer = request.headers.get('Authorization') ?? '';
  if (!/^Bearer [a-f0-9]{64}$/.test(bearer)) throw new ApiError(401, 'mobile_unauthorized');
  const mobile = await env.DB.prepare('SELECT * FROM android_devices WHERE bearer_hash=? AND revoked_at_ms IS NULL').bind(await digest(bearer.slice(7))).first<Mobile>();
  if (!mobile) throw new ApiError(401, 'mobile_unauthorized');
  return mobile;
}
export async function mobileRoute(request: Request, env: Env, now: number): Promise<Response> {
  const url = new URL(request.url), path = url.pathname;
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new ApiError(400, 'https_required');
  if (url.search || request.url.includes('?')) throw new ApiError(400, 'query_not_allowed');
  if (path === '/api/admin/mobile/revoke' && request.method === 'POST') {
    await admin(request, env);
    const body = object(await rawBody(request)); fields(body, ['deviceId']);
    const id = deviceId(body.deviceId, env);
    await env.DB.batch([
      env.DB.prepare('UPDATE android_devices SET revoked_at_ms=?,fcm_cipher=NULL,token_version=token_version+1,updated_at_ms=? WHERE device_id=? AND revoked_at_ms IS NULL').bind(now, now, id),
      env.DB.prepare("UPDATE push_jobs SET state='PERMANENT_FAILURE',last_error='REVOKED' WHERE device_id=? AND state IN ('PENDING','RETRY')").bind(id),
      env.DB.prepare('UPDATE alert_settings SET enabled=0,updated_at_ms=? WHERE device_id=?').bind(now, id),
      env.DB.prepare('UPDATE mobile_pairings SET expires_at_ms=MIN(expires_at_ms,?) WHERE device_id=? AND claimed_at_ms IS NULL').bind(now, id)
    ]);
    return json({ status: 'revoked' });
  }
  if (path === '/api/admin/pairing/start' && request.method === 'POST') {
    await admin(request, env);
    const body = object(await rawBody(request)); fields(body, ['deviceId']);
    const id = deviceId(body.deviceId, env), code = randomToken();
    await env.DB.prepare('INSERT INTO mobile_pairings(code_hash,device_id,created_at_ms,expires_at_ms) VALUES (?,?,?,?)').bind(await digest(code), id, now, now + 300000).run();
    return json({ pairingCode: code, expiresAt: new Date(now + 300000).toISOString() }, 201);
  }
  if (path === '/api/mobile/pairing/claim' && request.method === 'POST') {
    await rateLimit(request, env, now);
    const body = object(await rawBody(request)); fields(body, ['pairingCode', 'mobileId']);
    if (typeof body.pairingCode !== 'string' || !/^[a-f0-9]{64}$/.test(body.pairingCode) || typeof body.mobileId !== 'string' || !/^[a-f0-9-]{32,64}$/.test(body.mobileId)) throw new ApiError(400, 'invalid_pairing');
    const bearer = randomToken(), bearerHash = await digest(bearer), hash = await digest(body.pairingCode);
    // The claim update and conditional insertion share a transaction. A random claim
    // proof prevents concurrent requests with the same mobileId from winning twice.
    const claimId = randomToken();
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE mobile_pairings SET claimed_at_ms=?,claimed_mobile_id=?,claim_id=? WHERE code_hash=? AND claimed_at_ms IS NULL AND expires_at_ms>?
        AND NOT EXISTS(SELECT 1 FROM android_devices WHERE (device_id=mobile_pairings.device_id AND revoked_at_ms IS NULL) OR mobile_id=?) RETURNING device_id`).bind(now, body.mobileId, claimId, hash, now, body.mobileId),
      env.DB.prepare(`INSERT INTO android_devices(mobile_id,device_id,bearer_hash,created_at_ms,updated_at_ms)
        SELECT ?,device_id,?,?,? FROM mobile_pairings WHERE code_hash=? AND claim_id=?`).bind(body.mobileId, bearerHash, now, now, hash, claimId),
      env.DB.prepare(`INSERT INTO alert_settings(device_id,enabled,mode,expires_at_ms,updated_at_ms)
        SELECT device_id,0,'UNTIL_MANUALLY_DISABLED',NULL,? FROM mobile_pairings WHERE code_hash=? AND claim_id=?
        ON CONFLICT(device_id) DO UPDATE SET enabled=0,expires_at_ms=NULL,updated_at_ms=excluded.updated_at_ms`).bind(now, hash, claimId)
    ]) as D1Result<{ device_id: string }>[];
    if (!results[0].results.length) throw new ApiError(400, 'invalid_pairing');
    return json({ bearerToken: bearer, deviceId: results[0].results[0].device_id, tokenVersion: 1 }, 201);
  }
  const mobile = await authenticateMobile(request, env);
  if (path === '/api/mobile/monitoring' && ['GET','PUT'].includes(request.method)) return json(await monitoringRoute(env.DB,mobile,now,request.method==='PUT'?object(await rawBody(request)):undefined));
  if (path === '/api/mobile/status' && request.method === 'GET') {
    const agent = await env.DB.prepare('SELECT * FROM agents WHERE device_id=?').bind(mobile.device_id).first<AgentRow>();
    const setting = await env.DB.prepare('SELECT * FROM alert_settings WHERE device_id=?').bind(mobile.device_id).first<{ enabled: number; mode: string; expires_at_ms: number | null }>();
    return json({ deviceId: mobile.device_id, serverNow: now, pairedAt: mobile.created_at_ms, agent, effectiveStatus: effectiveStatus(agent, now), fcmRegistered: !!mobile.fcm_cipher,
      monitoring: monitoringView(await env.DB.prepare('SELECT * FROM monitoring_settings WHERE device_id=?').bind(mobile.device_id).first<Monitoring>(),now), offlineAlerts: !!mobile.offline_alerts, alertSetting: { ...setting, effectiveEnabled: !!setting?.enabled && (setting.mode !== 'TIMED' || (setting.expires_at_ms ?? 0) > now) } });
  }
  const body = object(await rawBody(request));
  if (path === '/api/mobile/offline-settings' && request.method === 'PUT') {
    fields(body, ['offlineAlerts']);
    if (typeof body.offlineAlerts !== 'boolean') throw new ApiError(400, 'invalid_enabled');
    await env.DB.prepare('UPDATE android_devices SET offline_alerts=?,updated_at_ms=? WHERE mobile_id=? AND revoked_at_ms IS NULL').bind(body.offlineAlerts ? 1 : 0, now, mobile.mobile_id).run();
    return json({ status: 'ok' });
  }
  if (path === '/api/mobile/fcm-token' && request.method === 'POST') {
    fields(body, ['token']); const token = text(body.token, 4096);
    if (/\s/.test(token)) throw new ApiError(400, 'invalid_token');
    await env.DB.prepare('UPDATE android_devices SET fcm_cipher=?,fcm_version=fcm_version+1,updated_at_ms=? WHERE mobile_id=? AND revoked_at_ms IS NULL').bind(await protectToken(env, token), now, mobile.mobile_id).run();
    return json({ status: 'registered' });
  }
  if (path === '/api/mobile/alert-settings' && request.method === 'PUT') {
    if(await env.DB.prepare('SELECT 1 FROM monitoring_settings WHERE device_id=?').bind(mobile.device_id).first())throw new ApiError(409,'monitoring_api_required');
    fields(body, ['enabled', 'mode', 'durationMinutes', 'offlineAlerts']);
    if (typeof body.enabled !== 'boolean' || (body.offlineAlerts !== undefined && typeof body.offlineAlerts !== 'boolean')) throw new ApiError(400, 'invalid_enabled');
    const mode = choice(body.mode, ['TIMED', 'UNTIL_MANUALLY_DISABLED']);
    let expires: number | null = null;
    if (body.enabled && mode === 'TIMED') {
      if (!Number.isInteger(body.durationMinutes) || Number(body.durationMinutes) < 1 || Number(body.durationMinutes) > 1440) throw new ApiError(400, 'invalid_duration');
      expires = now + Number(body.durationMinutes) * 60000;
    }
    const saved=await env.DB.batch([
      env.DB.prepare(`INSERT INTO alert_settings(device_id,enabled,mode,expires_at_ms,updated_at_ms) SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM monitoring_settings WHERE device_id=?)
        ON CONFLICT(device_id) DO UPDATE SET enabled=excluded.enabled,mode=excluded.mode,expires_at_ms=excluded.expires_at_ms,updated_at_ms=excluded.updated_at_ms WHERE NOT EXISTS(SELECT 1 FROM monitoring_settings WHERE device_id=excluded.device_id)`).bind(mobile.device_id, body.enabled ? 1 : 0, mode, expires, now,mobile.device_id),
      env.DB.prepare('UPDATE android_devices SET offline_alerts=?,updated_at_ms=? WHERE mobile_id=? AND revoked_at_ms IS NULL').bind(body.offlineAlerts === undefined ? mobile.offline_alerts : body.offlineAlerts ? 1 : 0, now, mobile.mobile_id)
    ]);
    if(!saved[0].meta.changes)throw new ApiError(409,'monitoring_api_required');
    return json({ enabled: body.enabled, mode, expiresAtMs: expires, serverNow: now });
  }
  if (path === '/api/mobile/ack' && request.method === 'POST') {
    fields(body, ['eventId', 'status']); const event = text(body.eventId), status = choice(body.status, ['RECEIVED', 'RINGING', 'STOPPED', 'NOTIFICATION_FALLBACK']);
    const result = await env.DB.prepare(`INSERT INTO mobile_acks(mobile_id,event_id,status,received_at_ms)
      SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM push_jobs WHERE mobile_id=? AND event_id=?)
      ON CONFLICT(mobile_id,event_id,status) DO UPDATE SET received_at_ms=mobile_acks.received_at_ms RETURNING event_id`).bind(mobile.mobile_id, event, status, now, mobile.mobile_id, event).first();
    if (!result) throw new ApiError(404, 'event_not_found');
    return json({ status: 'ok' });
  }
  if (path === '/api/mobile/unpair' && request.method === 'POST') {
    fields(body, []);
    await env.DB.batch([
      env.DB.prepare('UPDATE android_devices SET revoked_at_ms=?,fcm_cipher=NULL,token_version=token_version+1,updated_at_ms=? WHERE mobile_id=?').bind(now, now, mobile.mobile_id),
      env.DB.prepare("UPDATE push_jobs SET state='PERMANENT_FAILURE',last_error='REVOKED' WHERE mobile_id=? AND state IN ('PENDING','RETRY')").bind(mobile.mobile_id)
    ]);
    return json({ status: 'unpaired' });
  }
  return json({ error: 'not_found' }, 404);
}
