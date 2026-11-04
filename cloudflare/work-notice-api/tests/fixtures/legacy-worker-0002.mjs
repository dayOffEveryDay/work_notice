var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/security.ts
var ApiError = class extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
  status;
  code;
  static {
    __name(this, "ApiError");
  }
};
var encoder = new TextEncoder();
var hex = /* @__PURE__ */ __name((bytes) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join(""), "hex");
var allowed = /* @__PURE__ */ __name((list, value) => (list ?? "").split(",").map((x) => x.trim()).includes(value), "allowed");
function deviceId(value, env) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) throw new ApiError(400, "invalid_device");
  if (!allowed(env.ALLOWED_DEVICE_IDS, value)) throw new ApiError(403, "device_not_allowed");
  return value;
}
__name(deviceId, "deviceId");
function configured(env) {
  if (!env.AGENT_HMAC_SECRET || !env.ADMIN_API_KEY || env.AGENT_HMAC_SECRET.length < 32 || env.ADMIN_API_KEY.length < 32 || env.AGENT_HMAC_SECRET === env.ADMIN_API_KEY)
    throw new ApiError(503, "security_not_configured");
}
__name(configured, "configured");
async function admin(request, env) {
  configured(env);
  const supplied = request.headers.get("Authorization") ?? "";
  const expected = `Bearer ${env.ADMIN_API_KEY}`;
  const a = await crypto.subtle.digest("SHA-256", encoder.encode(supplied));
  const b = await crypto.subtle.digest("SHA-256", encoder.encode(expected));
  if (!crypto.subtle.timingSafeEqual(a, b)) throw new ApiError(401, "unauthorized");
}
__name(admin, "admin");
async function rawBody(request) {
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new ApiError(415, "json_required");
  const length = request.headers.get("Content-Length");
  if (length && (!/^\d+$/.test(length) || Number(length) > 8192)) throw new ApiError(413, "body_too_large");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "body_required");
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 8192) {
      await reader.cancel();
      throw new ApiError(413, "body_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
__name(rawBody, "rawBody");
function object(bytes) {
  try {
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!body || Array.isArray(body) || typeof body !== "object") throw new Error();
    return body;
  } catch {
    throw new ApiError(400, "invalid_json");
  }
}
__name(object, "object");
function fields(body, names) {
  if (Object.keys(body).some((name) => !names.includes(name))) throw new ApiError(400, "unknown_field");
}
__name(fields, "fields");
function text(value, max = 128) {
  if (typeof value !== "string" || !value.length || value.length > max || /[\u0000-\u001f]/.test(value)) throw new ApiError(400, "invalid_field");
  return value;
}
__name(text, "text");
function choice(value, values) {
  if (typeof value !== "string" || !values.includes(value)) throw new ApiError(400, "invalid_field");
  return value;
}
__name(choice, "choice");
async function authenticate(request, env, bytes, now) {
  configured(env);
  const url = new URL(request.url);
  if (url.search || request.url.includes("?")) throw new ApiError(400, "query_not_allowed");
  const id = deviceId(request.headers.get("X-Device-Id"), env);
  const timestamp = request.headers.get("X-Timestamp") ?? "";
  const nonce = request.headers.get("X-Nonce") ?? "";
  const signature = request.headers.get("X-Signature") ?? "";
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(now / 1e3 - Number(timestamp)) > 300) throw new ApiError(401, "timestamp_outside_window");
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || !/^v1=[0-9a-f]{64}$/.test(signature)) throw new ApiError(401, "invalid_signature");
  const hash = hex(await crypto.subtle.digest("SHA-256", bytes));
  const canonical = [request.method.toUpperCase(), url.pathname, id, timestamp, nonce, hash].join("\n");
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.AGENT_HMAC_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const supplied = Uint8Array.from(signature.slice(3).match(/../g), (pair) => parseInt(pair, 16));
  if (!await crypto.subtle.verify("HMAC", key, supplied, encoder.encode(canonical))) throw new ApiError(401, "invalid_signature");
  return { id, nonce, expires: (Number(timestamp) + 301) * 1e3 };
}
__name(authenticate, "authenticate");

// src/database.ts
function effectiveStatus(agent, now) {
  if (!agent || agent.last_seen_at_ms === null) return "UNKNOWN";
  if (agent.reported_mode === "STOPPED_BY_USER") return "STOPPED_BY_USER";
  if (now - agent.last_seen_at_ms > 18e4) return "OFFLINE";
  if (agent.listener_status !== "READY" || agent.notification_permission !== "ALLOWED" || !agent.telegram_source_confirmed) return "DEGRADED";
  return agent.reported_mode === "STANDBY" ? "STANDBY" : "MONITORING";
}
__name(effectiveStatus, "effectiveStatus");
function ensureAgent(db, id, now) {
  return db.prepare("INSERT INTO agents(device_id,created_at_ms,updated_at_ms) VALUES (?,?,?) ON CONFLICT(device_id) DO NOTHING").bind(id, now, now);
}
__name(ensureAgent, "ensureAgent");
function transition(db, now, id) {
  return db.prepare(`WITH statuses AS (
    SELECT device_id, CASE
      WHEN last_seen_at_ms IS NULL THEN 'UNKNOWN'
      WHEN reported_mode='STOPPED_BY_USER' THEN 'STOPPED_BY_USER'
      WHEN last_seen_at_ms < ? THEN 'OFFLINE'
      WHEN listener_status!='READY' OR notification_permission!='ALLOWED' OR telegram_source_confirmed=0 THEN 'DEGRADED'
      WHEN reported_mode='STANDBY' THEN 'STANDBY' ELSE 'MONITORING' END AS status FROM agents)
    INSERT INTO agent_status_transitions(device_id,status,observed_at_ms)
    SELECT device_id,status,? FROM statuses
    WHERE (? IS NULL OR device_id=?) AND status != COALESCE(
      (SELECT status FROM agent_status_transitions AS history WHERE history.device_id=statuses.device_id ORDER BY id DESC LIMIT 1),'')`).bind(now - 18e4, now, id, id);
}
__name(transition, "transition");
async function maintain(db, now) {
  await db.batch([
    transition(db, now, null),
    db.prepare("DELETE FROM request_nonces WHERE expires_at_ms <= ?").bind(now),
    db.prepare("DELETE FROM alert_events WHERE received_at_ms < ?").bind(now - 7 * 864e5)
  ]);
}
__name(maintain, "maintain");

// src/mobile.ts
var enc = new TextEncoder();
var digest = /* @__PURE__ */ __name(async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s))), "digest");
var randomToken = /* @__PURE__ */ __name(() => hex(crypto.getRandomValues(new Uint8Array(32)).buffer), "randomToken");
var json = /* @__PURE__ */ __name((data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } }), "json");
async function protectToken(env, value, decrypt = false) {
  if (!/^[a-f0-9]{64}$/.test(env.FCM_TOKEN_ENCRYPTION_KEY ?? "")) throw new ApiError(503, "token_encryption_not_configured");
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(env.FCM_TOKEN_ENCRYPTION_KEY.match(/../g), (s) => parseInt(s, 16)), "AES-GCM", false, ["encrypt", "decrypt"]);
  if (decrypt) {
    const bytes = Uint8Array.from(atob(value), (s) => s.charCodeAt(0));
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12)));
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(value)));
  return btoa(String.fromCharCode(...iv, ...encrypted));
}
__name(protectToken, "protectToken");
async function rateLimit(request, env, now) {
  const source = await digest(request.headers.get("CF-Connecting-IP") ?? "local");
  const window = Math.floor(now / 6e4) * 6e4;
  const result = await env.DB.batch(["global", source].map((bucket) => env.DB.prepare(`INSERT INTO mobile_rate_limits(bucket,window_ms,attempts) VALUES (?,?,1)
    ON CONFLICT(bucket,window_ms) DO UPDATE SET attempts=attempts+1 RETURNING attempts`).bind(bucket, window)));
  if (Number(result[0].results[0].attempts) > 100 || Number(result[1].results[0].attempts) > 10) throw new ApiError(429, "pairing_rate_limited");
}
__name(rateLimit, "rateLimit");
async function authenticateMobile(request, env) {
  const bearer = request.headers.get("Authorization") ?? "";
  if (!/^Bearer [a-f0-9]{64}$/.test(bearer)) throw new ApiError(401, "mobile_unauthorized");
  const mobile = await env.DB.prepare("SELECT * FROM android_devices WHERE bearer_hash=? AND revoked_at_ms IS NULL").bind(await digest(bearer.slice(7))).first();
  if (!mobile) throw new ApiError(401, "mobile_unauthorized");
  return mobile;
}
__name(authenticateMobile, "authenticateMobile");
async function mobileRoute(request, env, now) {
  const url = new URL(request.url), path = url.pathname;
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new ApiError(400, "https_required");
  if (url.search || request.url.includes("?")) throw new ApiError(400, "query_not_allowed");
  if (path === "/api/admin/mobile/revoke" && request.method === "POST") {
    await admin(request, env);
    const body2 = object(await rawBody(request));
    fields(body2, ["deviceId"]);
    const id = deviceId(body2.deviceId, env);
    await env.DB.batch([
      env.DB.prepare("UPDATE android_devices SET revoked_at_ms=?,fcm_cipher=NULL,token_version=token_version+1,updated_at_ms=? WHERE device_id=? AND revoked_at_ms IS NULL").bind(now, now, id),
      env.DB.prepare("UPDATE push_jobs SET state='PERMANENT_FAILURE',last_error='REVOKED' WHERE device_id=? AND state IN ('PENDING','RETRY')").bind(id),
      env.DB.prepare("UPDATE alert_settings SET enabled=0,updated_at_ms=? WHERE device_id=?").bind(now, id),
      env.DB.prepare("UPDATE mobile_pairings SET expires_at_ms=MIN(expires_at_ms,?) WHERE device_id=? AND claimed_at_ms IS NULL").bind(now, id)
    ]);
    return json({ status: "revoked" });
  }
  if (path === "/api/admin/pairing/start" && request.method === "POST") {
    await admin(request, env);
    const body2 = object(await rawBody(request));
    fields(body2, ["deviceId"]);
    const id = deviceId(body2.deviceId, env), code = randomToken();
    await env.DB.prepare("INSERT INTO mobile_pairings(code_hash,device_id,created_at_ms,expires_at_ms) VALUES (?,?,?,?)").bind(await digest(code), id, now, now + 3e5).run();
    return json({ pairingCode: code, expiresAt: new Date(now + 3e5).toISOString() }, 201);
  }
  if (path === "/api/mobile/pairing/claim" && request.method === "POST") {
    await rateLimit(request, env, now);
    const body2 = object(await rawBody(request));
    fields(body2, ["pairingCode", "mobileId"]);
    if (typeof body2.pairingCode !== "string" || !/^[a-f0-9]{64}$/.test(body2.pairingCode) || typeof body2.mobileId !== "string" || !/^[a-f0-9-]{32,64}$/.test(body2.mobileId)) throw new ApiError(400, "invalid_pairing");
    const bearer = randomToken(), bearerHash = await digest(bearer), hash = await digest(body2.pairingCode);
    const claimId = randomToken();
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE mobile_pairings SET claimed_at_ms=?,claimed_mobile_id=?,claim_id=? WHERE code_hash=? AND claimed_at_ms IS NULL AND expires_at_ms>?
        AND NOT EXISTS(SELECT 1 FROM android_devices WHERE (device_id=mobile_pairings.device_id AND revoked_at_ms IS NULL) OR mobile_id=?) RETURNING device_id`).bind(now, body2.mobileId, claimId, hash, now, body2.mobileId),
      env.DB.prepare(`INSERT INTO android_devices(mobile_id,device_id,bearer_hash,created_at_ms,updated_at_ms)
        SELECT ?,device_id,?,?,? FROM mobile_pairings WHERE code_hash=? AND claim_id=?`).bind(body2.mobileId, bearerHash, now, now, hash, claimId),
      env.DB.prepare(`INSERT INTO alert_settings(device_id,enabled,mode,expires_at_ms,updated_at_ms)
        SELECT device_id,0,'UNTIL_MANUALLY_DISABLED',NULL,? FROM mobile_pairings WHERE code_hash=? AND claim_id=?
        ON CONFLICT(device_id) DO UPDATE SET enabled=0,expires_at_ms=NULL,updated_at_ms=excluded.updated_at_ms`).bind(now, hash, claimId)
    ]);
    if (!results[0].results.length) throw new ApiError(400, "invalid_pairing");
    return json({ bearerToken: bearer, deviceId: results[0].results[0].device_id, tokenVersion: 1 }, 201);
  }
  const mobile = await authenticateMobile(request, env);
  if (path === "/api/mobile/status" && request.method === "GET") {
    const agent = await env.DB.prepare("SELECT * FROM agents WHERE device_id=?").bind(mobile.device_id).first();
    const setting = await env.DB.prepare("SELECT * FROM alert_settings WHERE device_id=?").bind(mobile.device_id).first();
    return json({
      deviceId: mobile.device_id,
      serverNow: now,
      pairedAt: mobile.created_at_ms,
      agent,
      effectiveStatus: effectiveStatus(agent, now),
      fcmRegistered: !!mobile.fcm_cipher,
      offlineAlerts: !!mobile.offline_alerts,
      alertSetting: { ...setting, effectiveEnabled: !!setting?.enabled && (setting.mode !== "TIMED" || (setting.expires_at_ms ?? 0) > now) }
    });
  }
  const body = object(await rawBody(request));
  if (path === "/api/mobile/offline-settings" && request.method === "PUT") {
    fields(body, ["offlineAlerts"]);
    if (typeof body.offlineAlerts !== "boolean") throw new ApiError(400, "invalid_enabled");
    await env.DB.prepare("UPDATE android_devices SET offline_alerts=?,updated_at_ms=? WHERE mobile_id=? AND revoked_at_ms IS NULL").bind(body.offlineAlerts ? 1 : 0, now, mobile.mobile_id).run();
    return json({ status: "ok" });
  }
  if (path === "/api/mobile/fcm-token" && request.method === "POST") {
    fields(body, ["token"]);
    const token = text(body.token, 4096);
    if (/\s/.test(token)) throw new ApiError(400, "invalid_token");
    await env.DB.prepare("UPDATE android_devices SET fcm_cipher=?,fcm_version=fcm_version+1,updated_at_ms=? WHERE mobile_id=? AND revoked_at_ms IS NULL").bind(await protectToken(env, token), now, mobile.mobile_id).run();
    return json({ status: "registered" });
  }
  if (path === "/api/mobile/alert-settings" && request.method === "PUT") {
    fields(body, ["enabled", "mode", "durationMinutes", "offlineAlerts"]);
    if (typeof body.enabled !== "boolean" || body.offlineAlerts !== void 0 && typeof body.offlineAlerts !== "boolean") throw new ApiError(400, "invalid_enabled");
    const mode = choice(body.mode, ["TIMED", "UNTIL_MANUALLY_DISABLED"]);
    let expires = null;
    if (body.enabled && mode === "TIMED") {
      if (!Number.isInteger(body.durationMinutes) || Number(body.durationMinutes) < 1 || Number(body.durationMinutes) > 1440) throw new ApiError(400, "invalid_duration");
      expires = now + Number(body.durationMinutes) * 6e4;
    }
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO alert_settings(device_id,enabled,mode,expires_at_ms,updated_at_ms) VALUES (?,?,?,?,?)
        ON CONFLICT(device_id) DO UPDATE SET enabled=excluded.enabled,mode=excluded.mode,expires_at_ms=excluded.expires_at_ms,updated_at_ms=excluded.updated_at_ms`).bind(mobile.device_id, body.enabled ? 1 : 0, mode, expires, now),
      env.DB.prepare("UPDATE android_devices SET offline_alerts=?,updated_at_ms=? WHERE mobile_id=? AND revoked_at_ms IS NULL").bind(body.offlineAlerts === void 0 ? mobile.offline_alerts : body.offlineAlerts ? 1 : 0, now, mobile.mobile_id)
    ]);
    return json({ enabled: body.enabled, mode, expiresAtMs: expires, serverNow: now });
  }
  if (path === "/api/mobile/ack" && request.method === "POST") {
    fields(body, ["eventId", "status"]);
    const event = text(body.eventId), status = choice(body.status, ["RECEIVED", "RINGING", "STOPPED", "NOTIFICATION_FALLBACK"]);
    const result = await env.DB.prepare(`INSERT INTO mobile_acks(mobile_id,event_id,status,received_at_ms)
      SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM push_jobs WHERE mobile_id=? AND event_id=?)
      ON CONFLICT(mobile_id,event_id,status) DO UPDATE SET received_at_ms=mobile_acks.received_at_ms RETURNING event_id`).bind(mobile.mobile_id, event, status, now, mobile.mobile_id, event).first();
    if (!result) throw new ApiError(404, "event_not_found");
    return json({ status: "ok" });
  }
  if (path === "/api/mobile/unpair" && request.method === "POST") {
    fields(body, []);
    await env.DB.batch([
      env.DB.prepare("UPDATE android_devices SET revoked_at_ms=?,fcm_cipher=NULL,token_version=token_version+1,updated_at_ms=? WHERE mobile_id=?").bind(now, now, mobile.mobile_id),
      env.DB.prepare("UPDATE push_jobs SET state='PERMANENT_FAILURE',last_error='REVOKED' WHERE mobile_id=? AND state IN ('PENDING','RETRY')").bind(mobile.mobile_id)
    ]);
    return json({ status: "unpaired" });
  }
  return json({ error: "not_found" }, 404);
}
__name(mobileRoute, "mobileRoute");

// src/push-errors.ts
var PushFailure = class extends Error {
  constructor(stage, code, httpStatus = null, retryable = true) {
    super(`${stage}:${httpStatus ?? 0}:${code}`);
    this.stage = stage;
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
  }
  stage;
  code;
  httpStatus;
  retryable;
  static {
    __name(this, "PushFailure");
  }
};
var oauthCodes = /* @__PURE__ */ new Set(["invalid_request", "invalid_client", "invalid_grant", "unauthorized_client", "unsupported_grant_type", "invalid_scope", "access_denied", "temporarily_unavailable", "server_error"]);
var fcmCodes = /* @__PURE__ */ new Set(["UNREGISTERED", "SENDER_ID_MISMATCH", "INVALID_ARGUMENT", "QUOTA_EXCEEDED", "UNAVAILABLE", "INTERNAL", "THIRD_PARTY_AUTH_ERROR", "PERMISSION_DENIED", "UNAUTHENTICATED", "NOT_FOUND", "RESOURCE_EXHAUSTED"]);
function oauthCode(body) {
  const value = body && typeof body === "object" ? body.error : void 0;
  return typeof value === "string" && oauthCodes.has(value) ? value.toUpperCase() : "HTTP_ERROR";
}
__name(oauthCode, "oauthCode");
function fcmCode(body) {
  const error = body && typeof body === "object" ? body.error : void 0;
  if (!error || typeof error !== "object") return "HTTP_ERROR";
  const { details, status } = error;
  if (Array.isArray(details)) {
    for (const detail of details) {
      const value = detail && typeof detail === "object" ? detail.errorCode : void 0;
      if (typeof value === "string" && fcmCodes.has(value)) return value;
    }
  }
  return typeof status === "string" && fcmCodes.has(status) ? status : "HTTP_ERROR";
}
__name(fcmCode, "fcmCode");
function networkFailure(stage, error) {
  const code = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError") ? "TIMEOUT" : error instanceof Error && error.message.includes("Illegal invocation") ? "ILLEGAL_INVOCATION" : error instanceof Error && error.message.includes("Invalid redirect value") ? "INVALID_REDIRECT_MODE" : "FETCH_FAILED";
  return new PushFailure(stage, code);
}
__name(networkFailure, "networkFailure");
function logPushFailure(failure, jobId, attempt, state) {
  console.warn(JSON.stringify({ event: "push_failure", jobId, attempt, state, stage: failure.stage, httpStatus: failure.httpStatus, code: failure.code, retryable: failure.retryable }));
}
__name(logPushFailure, "logPushFailure");
function logDispatchFailure() {
  console.error(JSON.stringify({ event: "push_dispatch_failed", stage: "DISPATCH", code: "UNEXPECTED_FAILURE" }));
}
__name(logDispatchFailure, "logDispatchFailure");

// src/fcm.ts
var encoder2 = new TextEncoder();
var base64url = /* @__PURE__ */ __name((s) => btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""), "base64url");
var encodeJson = /* @__PURE__ */ __name((value) => base64url(String.fromCharCode(...encoder2.encode(JSON.stringify(value)))), "encodeJson");
var FcmSender = class {
  // Workers' native fetch requires the global receiver. Never store it directly
  // and call it as this.transport(): Node mocks do not expose that runtime bug.
  constructor(transport = (input, init) => globalThis.fetch(input, init)) {
    this.transport = transport;
  }
  transport;
  static {
    __name(this, "FcmSender");
  }
  cache;
  async access(env, now, force = false) {
    const cacheKey = await digest(env.FCM_SERVICE_ACCOUNT_JSON);
    if (!force && this.cache?.key === cacheKey && this.cache.expires > now + 6e4) return this.cache.value;
    let sa;
    try {
      sa = JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON.trim());
    } catch {
      throw new PushFailure("SERVICE_ACCOUNT", "INVALID_JSON", null, false);
    }
    if (!sa || typeof sa !== "object" || sa.type !== "service_account" || typeof sa.client_email !== "string" || !sa.client_email || typeof sa.private_key !== "string")
      throw new PushFailure("SERVICE_ACCOUNT", "INVALID_FIELDS", null, false);
    if (sa.project_id !== env.FCM_PROJECT_ID) throw new PushFailure("SERVICE_ACCOUNT", "PROJECT_MISMATCH", null, false);
    const unsigned = encodeJson({ alg: "RS256", typ: "JWT" }) + "." + encodeJson({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: Math.floor(now / 1e3),
      exp: Math.floor(now / 1e3) + 3600
    });
    let key;
    try {
      const pem = sa.private_key.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").trim();
      if (!pem.startsWith("-----BEGIN PRIVATE KEY-----") || !pem.endsWith("-----END PRIVATE KEY-----")) throw new Error();
      const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, "")), (s) => s.charCodeAt(0));
      key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    } catch {
      throw new PushFailure("JWT_IMPORT", "INVALID_PKCS8_KEY", null, false);
    }
    let signature;
    try {
      signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder2.encode(unsigned)));
    } catch {
      throw new PushFailure("JWT_SIGN", "SIGN_FAILED", null, false);
    }
    let response;
    try {
      response = await this.transport("https://oauth2.googleapis.com/token", {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(8e3),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: unsigned + "." + base64url(String.fromCharCode(...signature)) }).toString()
      });
    } catch (error) {
      throw networkFailure("OAUTH_NETWORK", error);
    }
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new PushFailure("OAUTH_HTTP", oauthCode(result), response.status, response.status === 408 || response.status === 429 || response.status >= 500);
    if (!result || typeof result.access_token !== "string" || !result.access_token || typeof result.expires_in !== "number" || !Number.isFinite(result.expires_in) || result.expires_in <= 60)
      throw new PushFailure("OAUTH_RESPONSE", "INVALID_TOKEN_RESPONSE", response.status);
    this.cache = { key: cacheKey, value: result.access_token, expires: now + Math.min(result.expires_in, 3600) * 1e3 };
    return result.access_token;
  }
  async send(env, token, data, ttl, now, report = () => {
  }) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const access = await this.access(env, now, attempt === 1);
      let response;
      try {
        response = await this.transport(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(env.FCM_PROJECT_ID)}/messages:send`, {
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(8e3),
          headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
          body: JSON.stringify({ message: { token, data, android: { priority: "HIGH", ttl: `${Math.max(1, Math.min(120, ttl))}s` } } })
        });
      } catch (error) {
        throw networkFailure("FCM_NETWORK", error);
      }
      const body = await response.json().catch(() => null);
      if (response.ok) {
        if (!body || typeof body.name !== "string" || !body.name) throw new PushFailure("FCM_RESPONSE", "INVALID_SEND_RESPONSE", response.status);
        return "SENT_TO_FCM";
      }
      const code = fcmCode(body);
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      report(new PushFailure("FCM_HTTP", code, response.status, retryable || response.status === 401 && attempt === 0));
      if (response.status === 401 && attempt === 0) continue;
      if (code === "UNREGISTERED") return "UNREGISTERED";
      return retryable ? "RETRY" : "PERMANENT_FAILURE";
    }
    return "PERMANENT_FAILURE";
  }
};
var sender = new FcmSender();
async function dispatchPush(env, now = Date.now(), client = sender) {
  const db = env.DB;
  await db.prepare("UPDATE push_jobs SET state='EXPIRED',last_error=COALESCE(last_error,'TTL_EXPIRED') WHERE state IN ('PENDING','RETRY') AND expires_at_ms<=?").bind(now).run();
  const lease = randomToken();
  const jobs = await db.prepare(`UPDATE push_jobs SET lease_id=?,lease_until_ms=?,attempts=attempts+1
    WHERE id IN (SELECT id FROM push_jobs WHERE state IN ('PENDING','RETRY') AND expires_at_ms>? AND next_attempt_ms<=? AND lease_until_ms<=? AND attempts<5 ORDER BY id LIMIT 20) RETURNING *`).bind(lease, now + 6e4, now, now, now).all();
  await Promise.all(jobs.results.map(async (job) => {
    const mobile = await db.prepare("SELECT fcm_cipher,fcm_version FROM android_devices WHERE mobile_id=? AND revoked_at_ms IS NULL").bind(job.mobile_id).first();
    let state = "PERMANENT_FAILURE", error = "REVOKED_OR_NO_TOKEN";
    let failure;
    if (mobile?.fcm_cipher) {
      const setting = await db.prepare("SELECT enabled,mode,expires_at_ms FROM alert_settings WHERE device_id=?").bind(job.device_id).first();
      const enabled = setting?.enabled && (setting.mode !== "TIMED" || (setting.expires_at_ms ?? 0) > now);
      if (job.push_type === "WORK_ALERT" && !enabled) {
        state = "EXPIRED";
        error = "DISABLED";
      } else if (!env.FCM_PROJECT_ID || !env.FCM_SERVICE_ACCOUNT_JSON || !env.FCM_TOKEN_ENCRYPTION_KEY) {
        state = "PENDING";
        error = "NOT_CONFIGURED";
      } else {
        try {
          let token;
          try {
            token = await protectToken(env, mobile.fcm_cipher, true);
          } catch {
            throw new PushFailure("TOKEN_DECRYPT", "DECRYPT_FAILED", null, false);
          }
          state = await client.send(env, token, {
            type: job.push_type,
            eventId: job.event_id,
            issuedAt: new Date(job.created_at_ms).toISOString(),
            expiresAt: new Date(job.expires_at_ms).toISOString()
          }, Math.ceil((job.expires_at_ms - now) / 1e3), now, (detail) => {
            failure = detail;
            logPushFailure(detail, job.id, job.attempts, "ATTEMPT");
          });
          error = state === "SENT_TO_FCM" ? null : failure?.message ?? state;
          if (state === "UNREGISTERED") {
            await db.prepare("UPDATE android_devices SET fcm_cipher=NULL,updated_at_ms=? WHERE mobile_id=? AND fcm_version=?").bind(now, job.mobile_id, mobile.fcm_version).run();
            state = "PERMANENT_FAILURE";
          }
        } catch (caught) {
          failure = caught instanceof PushFailure ? caught : new PushFailure("DISPATCH", "UNEXPECTED_FAILURE");
          state = failure.retryable ? "RETRY" : "PERMANENT_FAILURE";
          error = failure.message;
          logPushFailure(failure, job.id, job.attempts, state);
        }
      }
    }
    if (job.attempts >= 5 && (state === "RETRY" || state === "PENDING")) {
      state = "PERMANENT_FAILURE";
      error ??= "ATTEMPTS_EXHAUSTED";
    }
    await db.prepare(`UPDATE push_jobs SET state=?,last_error=?,next_attempt_ms=?,lease_until_ms=0,lease_id=NULL,sent_at_ms=? WHERE id=? AND lease_id=? AND state IN ('PENDING','RETRY')`).bind(state, error, now + Math.min(6e4, 5e3 * 2 ** Math.min(job.attempts, 4)), state === "SENT_TO_FCM" ? now : null, job.id, lease).run();
  }));
}
__name(dispatchPush, "dispatchPush");
async function cleanupMobile(db, now) {
  await db.batch([
    db.prepare("DELETE FROM mobile_pairings WHERE expires_at_ms<?").bind(now - 864e5),
    db.prepare("DELETE FROM mobile_rate_limits WHERE window_ms<?").bind(now - 6e5),
    db.prepare("DELETE FROM mobile_acks WHERE received_at_ms<?").bind(now - 7 * 864e5),
    db.prepare("DELETE FROM push_jobs WHERE expires_at_ms<?").bind(now - 7 * 864e5)
  ]);
}
__name(cleanupMobile, "cleanupMobile");

// src/index.ts
var json2 = /* @__PURE__ */ __name((data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } }), "json");
async function handle(request, env, now = Date.now()) {
  try {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/mobile/") || ["/api/admin/pairing/start", "/api/admin/mobile/revoke"].includes(url.pathname)) return await mobileRoute(request, env, now);
    if (url.pathname === "/api/health") {
      if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
      return json2({ status: "ok" });
    }
    if (request.method === "POST" && ["/api/alert", "/api/heartbeat"].includes(url.pathname)) {
      if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new ApiError(400, "https_required");
      const bytes = await rawBody(request);
      const auth = await authenticate(request, env, bytes, now);
      const nonce = await env.DB.prepare("INSERT INTO request_nonces(device_id,nonce,expires_at_ms) VALUES (?,?,?) ON CONFLICT(device_id,nonce) DO NOTHING RETURNING nonce").bind(auth.id, auth.nonce, auth.expires).first();
      if (!nonce) throw new ApiError(409, "nonce_replayed");
      const body = object(bytes);
      if (body.deviceId !== auth.id) throw new ApiError(400, "device_mismatch");
      if (url.pathname === "/api/alert") validateAlert(body, env, now);
      else validateHeartbeat(body);
      return url.pathname === "/api/alert" ? await alert(env.DB, body, now) : await heartbeat(env.DB, body, now);
    }
    if (request.method === "GET" && url.pathname === "/api/device/status") {
      await admin(request, env);
      if (url.searchParams.getAll("deviceId").length !== 1 || [...url.searchParams.keys()].some((key) => key !== "deviceId")) throw new ApiError(400, "device_required");
      const id = deviceId(url.searchParams.get("deviceId"), env);
      const results = await env.DB.batch([
        env.DB.prepare("SELECT * FROM agents WHERE device_id=?").bind(id),
        env.DB.prepare("SELECT enabled,mode,expires_at_ms,updated_at_ms FROM alert_settings WHERE device_id=?").bind(id)
      ]);
      const agent = results[0].results[0] ?? null;
      const setting = results[1].results[0];
      const enabled = !!setting?.enabled && (setting.mode !== "TIMED" || (setting.expires_at_ms ?? 0) > now);
      return json2({ deviceId: id, agent, effectiveStatus: effectiveStatus(agent, now), alertSetting: { ...setting ?? { enabled: 0, mode: "UNTIL_MANUALLY_DISABLED", expires_at_ms: null }, effectiveEnabled: enabled } });
    }
    if (request.method === "PUT" && url.pathname === "/api/device/settings") {
      await admin(request, env);
      const body = object(await rawBody(request));
      fields(body, ["deviceId", "enabled", "mode", "durationMinutes"]);
      const id = deviceId(body.deviceId, env);
      if (typeof body.enabled !== "boolean") throw new ApiError(400, "invalid_enabled");
      const mode = choice(body.mode, ["TIMED", "UNTIL_MANUALLY_DISABLED"]);
      let expires = null;
      if (body.enabled && mode === "TIMED") {
        if (!Number.isInteger(body.durationMinutes) || Number(body.durationMinutes) < 1 || Number(body.durationMinutes) > 10080) throw new ApiError(400, "invalid_duration");
        expires = now + Number(body.durationMinutes) * 6e4;
      }
      await env.DB.batch([ensureAgent(env.DB, id, now), env.DB.prepare(`INSERT INTO alert_settings(device_id,enabled,mode,expires_at_ms,updated_at_ms) VALUES (?,?,?,?,?)
        ON CONFLICT(device_id) DO UPDATE SET enabled=excluded.enabled,mode=excluded.mode,expires_at_ms=excluded.expires_at_ms,updated_at_ms=excluded.updated_at_ms`).bind(id, body.enabled ? 1 : 0, mode, expires, now)]);
      return json2({ status: "ok", deviceId: id, enabled: body.enabled, mode, expiresAt: expires === null ? null : new Date(expires).toISOString() });
    }
    return json2({ error: "not_found" }, 404);
  } catch (error) {
    return error instanceof ApiError ? json2({ error: error.code }, error.status) : json2({ error: "internal_error" }, 500);
  }
}
__name(handle, "handle");
function validateAlert(body, env, now) {
  fields(body, ["eventId", "deviceId", "source", "aumid", "notificationId", "occurredAt"]);
  if (typeof body.eventId !== "string" || !/^[a-f0-9]{64}$/.test(body.eventId)) throw new ApiError(400, "invalid_event_id");
  if (body.source !== "TELEGRAM" || !allowed(env.ALLOWED_TELEGRAM_AUMIDS ?? "Telegram.TelegramDesktop", text(body.aumid, 512))) throw new ApiError(400, "invalid_source");
  if (!["number", "string"].includes(typeof body.notificationId) || !/^(0|[1-9]\d{0,9})$/.test(String(body.notificationId)) || Number(body.notificationId) > 4294967295) throw new ApiError(400, "invalid_notification_id");
  if (typeof body.occurredAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/.test(body.occurredAt) || !Number.isFinite(Date.parse(body.occurredAt)) || Date.parse(body.occurredAt) > now + 3e4) throw new ApiError(400, "invalid_occurred_at");
  if (new Date(Date.parse(body.occurredAt)).toISOString().slice(0, 19) !== body.occurredAt.slice(0, 19)) throw new ApiError(400, "invalid_occurred_at");
}
__name(validateAlert, "validateAlert");
function validateHeartbeat(body) {
  fields(body, ["deviceId", "sessionId", "agentMode", "listenerStatus", "notificationPermission", "telegramSourceConfirmed", "agentVersion"]);
  text(body.sessionId);
  text(body.agentVersion, 64);
  choice(body.agentMode, ["MONITORING", "STANDBY", "STOPPED_BY_USER"]);
  choice(body.listenerStatus, ["READY", "DEGRADED", "ERROR"]);
  choice(body.notificationPermission, ["ALLOWED", "DENIED", "UNSPECIFIED"]);
  if (typeof body.telegramSourceConfirmed !== "boolean") throw new ApiError(400, "invalid_confirmation");
}
__name(validateHeartbeat, "validateHeartbeat");
async function alert(db, body, now) {
  const id = String(body.deviceId);
  const occurred = Date.parse(String(body.occurredAt));
  const result = now - occurred > 12e4 ? "STALE" : "ACCEPTED";
  const results = await db.batch([
    ensureAgent(db, id, now),
    db.prepare(`INSERT INTO alert_events(device_id,event_id,source,aumid,notification_id,occurred_at_ms,received_at_ms,result,should_notify)
    VALUES (?,?,?,?,?,?,?,?,CASE WHEN ?='ACCEPTED' AND EXISTS(SELECT 1 FROM alert_settings WHERE device_id=? AND enabled=1 AND (mode='UNTIL_MANUALLY_DISABLED' OR (mode='TIMED' AND expires_at_ms>?))) THEN 1 ELSE 0 END)
    ON CONFLICT(device_id,event_id) DO NOTHING RETURNING should_notify`).bind(id, body.eventId, body.source, body.aumid, String(body.notificationId), occurred, now, result, result, id, now),
    db.prepare("SELECT result,should_notify FROM alert_events WHERE device_id=? AND event_id=?").bind(id, body.eventId)
  ]);
  const inserted = results[1].results.length > 0;
  return json2({ status: inserted ? result : "DUPLICATE", eventId: body.eventId, storedResult: results[2].results[0]?.result }, inserted && result === "ACCEPTED" ? 202 : 200);
}
__name(alert, "alert");
async function heartbeat(db, body, now) {
  const id = String(body.deviceId);
  const results = await db.batch([db.prepare(`INSERT INTO agents(device_id,reported_mode,listener_status,notification_permission,telegram_source_confirmed,last_session_id,agent_version,last_seen_at_ms,created_at_ms,updated_at_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET reported_mode=excluded.reported_mode,listener_status=excluded.listener_status,
    notification_permission=excluded.notification_permission,telegram_source_confirmed=excluded.telegram_source_confirmed,last_session_id=excluded.last_session_id,
    agent_version=excluded.agent_version,last_seen_at_ms=excluded.last_seen_at_ms,updated_at_ms=excluded.updated_at_ms
    WHERE excluded.reported_mode!='STOPPED_BY_USER' OR agents.last_session_id=excluded.last_session_id`).bind(id, body.agentMode, body.listenerStatus, body.notificationPermission, body.telegramSourceConfirmed ? 1 : 0, body.sessionId, body.agentVersion, now, now, now), transition(db, now, id)]);
  if (!results[0].meta.changes) throw new ApiError(409, "stale_session");
  return json2({ status: "ok", receivedAt: new Date(now).toISOString() });
}
__name(heartbeat, "heartbeat");
var src_default = {
  async fetch(request, env, ctx) {
    const response = await handle(request, env);
    if (ctx && request.method === "POST" && new URL(request.url).pathname === "/api/alert" && response.status === 202)
      ctx.waitUntil(dispatchPush(env).catch(() => {
        logDispatchFailure();
      }));
    return response;
  },
  async scheduled(_controller, env) {
    const now = Date.now();
    await maintain(env.DB, now);
    await dispatchPush(env, now);
    await cleanupMobile(env.DB, now);
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-XJgjGq/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-XJgjGq/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default,
  handle
};
//# sourceMappingURL=index.js.map
