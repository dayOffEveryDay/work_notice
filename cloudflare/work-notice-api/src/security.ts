export interface SecurityEnv {
  AGENT_HMAC_SECRET?: string;
  ADMIN_API_KEY?: string;
  ALLOWED_DEVICE_IDS?: string;
  ALLOWED_TELEGRAM_AUMIDS?: string;
  ALLOWED_LARK_A_CHROME_AUMIDS?: string;
  ALLOWED_LARK_B_BRAVE_AUMIDS?: string;
}
export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
const encoder = new TextEncoder();
export const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
export const allowed = (list: string | undefined, value: string) => (list ?? '').split(',').map(x => x.trim()).includes(value);
export function deviceId(value: unknown, env: SecurityEnv): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) throw new ApiError(400, 'invalid_device');
  if (!allowed(env.ALLOWED_DEVICE_IDS, value)) throw new ApiError(403, 'device_not_allowed');
  return value;
}
export function configured(env: SecurityEnv): void {
  if (!env.AGENT_HMAC_SECRET || !env.ADMIN_API_KEY || env.AGENT_HMAC_SECRET.length < 32 || env.ADMIN_API_KEY.length < 32 || env.AGENT_HMAC_SECRET === env.ADMIN_API_KEY)
    throw new ApiError(503, 'security_not_configured');
}
export async function admin(request: Request, env: SecurityEnv): Promise<void> {
  configured(env);
  const supplied = request.headers.get('Authorization') ?? '';
  const expected = `Bearer ${env.ADMIN_API_KEY}`;
  const a = await crypto.subtle.digest('SHA-256', encoder.encode(supplied));
  const b = await crypto.subtle.digest('SHA-256', encoder.encode(expected));
  if (!crypto.subtle.timingSafeEqual(a, b)) throw new ApiError(401, 'unauthorized');
}
export async function rawBody(request: Request): Promise<Uint8Array> {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new ApiError(415, 'json_required');
  const length = request.headers.get('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > 8192)) throw new ApiError(413, 'body_too_large');
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, 'body_required');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 8192) { await reader.cancel(); throw new ApiError(413, 'body_too_large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
export function object(bytes: Uint8Array): Record<string, unknown> {
  try {
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();
    return body;
  } catch { throw new ApiError(400, 'invalid_json'); }
}
export function fields(body: Record<string, unknown>, names: string[]): void {
  if (Object.keys(body).some(name => !names.includes(name))) throw new ApiError(400, 'unknown_field');
}
export function text(value: unknown, max = 128): string {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u001f]/.test(value)) throw new ApiError(400, 'invalid_field');
  return value;
}
export function choice(value: unknown, values: string[]): string {
  if (typeof value !== 'string' || !values.includes(value)) throw new ApiError(400, 'invalid_field');
  return value;
}
export async function authenticate(request: Request, env: SecurityEnv, bytes: Uint8Array, now: number) {
  configured(env);
  const url = new URL(request.url);
  if (url.search || request.url.includes('?')) throw new ApiError(400, 'query_not_allowed');
  const id = deviceId(request.headers.get('X-Device-Id'), env);
  const timestamp = request.headers.get('X-Timestamp') ?? '';
  const nonce = request.headers.get('X-Nonce') ?? '';
  const signature = request.headers.get('X-Signature') ?? '';
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) throw new ApiError(401, 'timestamp_outside_window');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || !/^v1=[0-9a-f]{64}$/.test(signature)) throw new ApiError(401, 'invalid_signature');
  const hash = hex(await crypto.subtle.digest('SHA-256', bytes));
  const canonical = [request.method.toUpperCase(), url.pathname, id, timestamp, nonce, hash].join('\n');
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.AGENT_HMAC_SECRET!), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const supplied = Uint8Array.from(signature.slice(3).match(/../g)!, pair => parseInt(pair, 16));
  if (!await crypto.subtle.verify('HMAC', key, supplied, encoder.encode(canonical))) throw new ApiError(401, 'invalid_signature');
  return { id, nonce, expires: (Number(timestamp) + 301) * 1000 };
}
