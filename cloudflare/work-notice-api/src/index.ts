import { monitoringView, type Monitoring } from './monitoring.js';
import { ApiError, admin, allowed, authenticate, choice, deviceId, fields, object, rawBody, text, type SecurityEnv } from './security.js';
import { effectiveStatus, ensureAgent, maintain, transition, type AgentRow } from './database.js';
import { mobileRoute } from './mobile.js';
import { cleanupMobile, dispatchPush } from './fcm.js';
import { logDispatchFailure } from './push-errors.js';
export interface Env extends SecurityEnv { DB: D1Database; FCM_PROJECT_ID?: string; FCM_SERVICE_ACCOUNT_JSON?: string; FCM_TOKEN_ENCRYPTION_KEY?: string; }
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

const sources = ['TELEGRAM', 'LARK_A_CHROME', 'LARK_B_BRAVE'];
// Browser allowlists are empty by default. One AUMID cannot represent multiple sources.
function validSource(source: unknown, aumid: string, env: Env): boolean {
  const lists = [env.ALLOWED_TELEGRAM_AUMIDS ?? 'Telegram.TelegramDesktop',
    env.ALLOWED_LARK_A_CHROME_AUMIDS, env.ALLOWED_LARK_B_BRAVE_AUMIDS];
  const matches = sources.filter((_, i) => allowed(lists[i], aumid));
  return matches.length === 1 && matches[0] === source;
}
async function cloudEventId(source: string, eventId: string): Promise<string> {
  if (source === 'TELEGRAM') return eventId; // Preserve legacy retry/dedup IDs.
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source + ':' + eventId));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

export async function handle(request: Request, env: Env, now = Date.now()): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/mobile/') || ['/api/admin/pairing/start','/api/admin/mobile/revoke'].includes(url.pathname)) return await mobileRoute(request, env, now);
    if (url.pathname === '/api/health') {
      if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } });
      return json({ status: 'ok' });
    }
    if (request.method === 'POST' && ['/api/alert', '/api/heartbeat'].includes(url.pathname)) {
      if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new ApiError(400, 'https_required');
      const bytes = await rawBody(request);
      const auth = await authenticate(request, env, bytes, now);
      const nonce = await env.DB.prepare('INSERT INTO request_nonces(device_id,nonce,expires_at_ms) VALUES (?,?,?) ON CONFLICT(device_id,nonce) DO NOTHING RETURNING nonce').bind(auth.id, auth.nonce, auth.expires).first();
      if (!nonce) throw new ApiError(409, 'nonce_replayed');
      const body = object(bytes);
      if (body.deviceId !== auth.id) throw new ApiError(400, 'device_mismatch');
      if (url.pathname === '/api/alert') validateAlert(body, env, now);
      else validateHeartbeat(body);
      return url.pathname === '/api/alert' ? await alert(env.DB, body, now) : await heartbeat(env.DB, body, now);
    }
    if (request.method === 'GET' && url.pathname === '/api/device/status') {
      await admin(request, env);
      if (url.searchParams.getAll('deviceId').length !== 1 || [...url.searchParams.keys()].some(key => key !== 'deviceId')) throw new ApiError(400, 'device_required');
      const id = deviceId(url.searchParams.get('deviceId'), env);
      const results = await env.DB.batch([
        env.DB.prepare('SELECT * FROM agents WHERE device_id=?').bind(id),
        env.DB.prepare('SELECT enabled,mode,expires_at_ms,updated_at_ms FROM alert_settings WHERE device_id=?').bind(id)]);
      const agent = (results[0].results[0] ?? null) as unknown as AgentRow | null;
      const setting = results[1].results[0] as { enabled: number; mode: string; expires_at_ms: number | null } | undefined;
      const enabled = !!setting?.enabled && (setting.mode !== 'TIMED' || (setting.expires_at_ms ?? 0) > now);
      return json({ monitoring:monitoringView(await env.DB.prepare('SELECT * FROM monitoring_settings WHERE device_id=?').bind(id).first<Monitoring>(),now), deviceId: id, agent, effectiveStatus: effectiveStatus(agent, now), alertSetting: { ...(setting ?? { enabled: 0, mode: 'UNTIL_MANUALLY_DISABLED', expires_at_ms: null }), effectiveEnabled: enabled } });
    }
    if (request.method === 'PUT' && url.pathname === '/api/device/settings') {
      await admin(request, env);
      const body = object(await rawBody(request));
      fields(body, ['deviceId', 'enabled', 'mode', 'durationMinutes']);
      const id = deviceId(body.deviceId, env);
      if(await env.DB.prepare('SELECT 1 FROM monitoring_settings WHERE device_id=?').bind(id).first())throw new ApiError(409,'monitoring_api_required');
      if (typeof body.enabled !== 'boolean') throw new ApiError(400, 'invalid_enabled');
      const mode = choice(body.mode, ['TIMED', 'UNTIL_MANUALLY_DISABLED']);
      let expires: number | null = null;
      if (body.enabled && mode === 'TIMED') {
        if (!Number.isInteger(body.durationMinutes) || Number(body.durationMinutes) < 1 || Number(body.durationMinutes) > 10080) throw new ApiError(400, 'invalid_duration');
        expires = now + Number(body.durationMinutes) * 60000;
      }
      const saved=await env.DB.batch([ensureAgent(env.DB, id, now), env.DB.prepare(`INSERT INTO alert_settings(device_id,enabled,mode,expires_at_ms,updated_at_ms) SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM monitoring_settings WHERE device_id=?)
        ON CONFLICT(device_id) DO UPDATE SET enabled=excluded.enabled,mode=excluded.mode,expires_at_ms=excluded.expires_at_ms,updated_at_ms=excluded.updated_at_ms WHERE NOT EXISTS(SELECT 1 FROM monitoring_settings WHERE device_id=excluded.device_id)`).bind(id, body.enabled ? 1 : 0, mode, expires, now,id)]);
      if(!saved[1].meta.changes)throw new ApiError(409,'monitoring_api_required');
      return json({ status: 'ok', deviceId: id, enabled: body.enabled, mode, expiresAt: expires === null ? null : new Date(expires).toISOString() });
    }
    return json({ error: 'not_found' }, 404);
  } catch (error) {
    // Never log raw bodies, authorization headers, secrets, or D1 exception text.
    return error instanceof ApiError ? json({ error: error.code }, error.status) : json({ error: 'internal_error' }, 500);
  }
}
function validateAlert(body: Record<string, unknown>, env: Env, now: number): void {
  fields(body, ['eventId', 'deviceId', 'source', 'aumid', 'notificationId', 'occurredAt']);
  if (typeof body.eventId !== 'string' || !/^[a-f0-9]{64}$/.test(body.eventId)) throw new ApiError(400, 'invalid_event_id');
  if (!validSource(body.source, text(body.aumid, 512), env)) throw new ApiError(400, 'invalid_source');
  if (!['number', 'string'].includes(typeof body.notificationId) || !/^(0|[1-9]\d{0,9})$/.test(String(body.notificationId)) || Number(body.notificationId) > 4294967295) throw new ApiError(400, 'invalid_notification_id');
  if (typeof body.occurredAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/.test(body.occurredAt) || !Number.isFinite(Date.parse(body.occurredAt)) || Date.parse(body.occurredAt) > now + 30000) throw new ApiError(400, 'invalid_occurred_at');
  if (new Date(Date.parse(body.occurredAt)).toISOString().slice(0, 19) !== body.occurredAt.slice(0, 19)) throw new ApiError(400, 'invalid_occurred_at');
}
function validateHeartbeat(body: Record<string, unknown>): void {
  fields(body, ['deviceId', 'sessionId', 'agentMode', 'listenerStatus', 'notificationPermission', 'telegramSourceConfirmed', 'agentVersion', 'enabledSources']);
  text(body.sessionId); text(body.agentVersion, 64);
  choice(body.agentMode, ['MONITORING', 'STANDBY', 'STOPPED_BY_USER']);
  choice(body.listenerStatus, ['READY', 'DEGRADED', 'ERROR']);
  choice(body.notificationPermission, ['ALLOWED', 'DENIED', 'UNSPECIFIED']);
  if (body.enabledSources != null && (!Array.isArray(body.enabledSources) || body.enabledSources.length > 3 ||
      body.enabledSources.some(s => typeof s !== 'string' || !sources.includes(s)) ||
      new Set(body.enabledSources).size !== body.enabledSources.length ||
      body.enabledSources.includes('TELEGRAM') && body.telegramSourceConfirmed !== true)) throw new ApiError(400, 'invalid_sources');
  if (typeof body.telegramSourceConfirmed !== 'boolean') throw new ApiError(400, 'invalid_confirmation');
}
async function alert(db: D1Database, body: Record<string, unknown>, now: number): Promise<Response> {
  const id = String(body.deviceId);
  const eventId = await cloudEventId(String(body.source), String(body.eventId));
  const occurred = Date.parse(String(body.occurredAt));
  const result = now - occurred > 120000 ? 'STALE' : 'ACCEPTED';
  const results = await db.batch([ensureAgent(db, id, now), db.prepare(`INSERT INTO alert_events(device_id,event_id,source,aumid,notification_id,occurred_at_ms,received_at_ms,result,should_notify)
    VALUES (?,?,?,?,?,?,?,?,CASE WHEN ?='ACCEPTED' AND (EXISTS(SELECT 1 FROM monitoring_settings WHERE device_id=? AND mode!='OFF' AND starts_at_ms<=? AND starts_at_ms<=?) OR (NOT EXISTS(SELECT 1 FROM monitoring_settings WHERE device_id=?) AND EXISTS(SELECT 1 FROM alert_settings WHERE device_id=? AND enabled=1 AND (mode='UNTIL_MANUALLY_DISABLED' OR (mode='TIMED' AND expires_at_ms>?))))) THEN 1 ELSE 0 END)
    ON CONFLICT(device_id,event_id) DO NOTHING RETURNING should_notify`).bind(id, eventId, body.source, body.aumid, String(body.notificationId), occurred, now, result, result, id, now, occurred,id,id,now),
    db.prepare('SELECT result,should_notify FROM alert_events WHERE device_id=? AND event_id=?').bind(id, eventId)]);
  const inserted = results[1].results.length > 0;
  return json({ status: inserted ? result : 'DUPLICATE', eventId, storedResult: (results[2].results[0] as { result: string } | undefined)?.result }, inserted && result === 'ACCEPTED' ? 202 : 200);
}
async function heartbeat(db: D1Database, body: Record<string, unknown>, now: number): Promise<Response> {
  const id = String(body.deviceId);
  const results = await db.batch([db.prepare(`INSERT INTO agents(device_id,reported_mode,listener_status,notification_permission,telegram_source_confirmed,last_session_id,agent_version,last_seen_at_ms,created_at_ms,updated_at_ms,enabled_sources)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET reported_mode=excluded.reported_mode,listener_status=excluded.listener_status,
    notification_permission=excluded.notification_permission,telegram_source_confirmed=excluded.telegram_source_confirmed,last_session_id=excluded.last_session_id,
    agent_version=excluded.agent_version,last_seen_at_ms=excluded.last_seen_at_ms,updated_at_ms=excluded.updated_at_ms,enabled_sources=excluded.enabled_sources
    WHERE excluded.reported_mode!='STOPPED_BY_USER' OR agents.last_session_id=excluded.last_session_id`).bind(id, body.agentMode, body.listenerStatus, body.notificationPermission, body.telegramSourceConfirmed ? 1 : 0, body.sessionId, body.agentVersion, now, now, now, body.enabledSources == null ? null : JSON.stringify(body.enabledSources)), transition(db, now, id)]);
  if (!results[0].meta.changes) throw new ApiError(409, 'stale_session');
  return json({ status: 'ok', receivedAt: new Date(now).toISOString() });
}
export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const response = await handle(request, env);
    if (ctx && request.method === 'POST' && new URL(request.url).pathname === '/api/alert' && response.status === 202)
      ctx.waitUntil(dispatchPush(env).catch(() => { logDispatchFailure(); }));
    return response;
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const now = Date.now(); await maintain(env.DB, now); await dispatchPush(env, now); await cleanupMobile(env.DB, now);
  }
} satisfies ExportedHandler<Env>;
