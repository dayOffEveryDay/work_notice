export type PushStage = 'SERVICE_ACCOUNT' | 'JWT_IMPORT' | 'JWT_SIGN' | 'OAUTH_NETWORK' | 'OAUTH_HTTP' | 'OAUTH_RESPONSE' | 'FCM_NETWORK' | 'FCM_HTTP' | 'FCM_RESPONSE' | 'TOKEN_DECRYPT' | 'DISPATCH';

/** Only locally defined or allowlisted codes may cross this boundary. Never include raw errors/bodies. */
export class PushFailure extends Error {
  constructor(public readonly stage: PushStage, public readonly code: string, public readonly httpStatus: number | null = null, public readonly retryable = true) {
    super(`${stage}:${httpStatus ?? 0}:${code}`);
  }
}
const oauthCodes = new Set(['invalid_request','invalid_client','invalid_grant','unauthorized_client','unsupported_grant_type','invalid_scope','access_denied','temporarily_unavailable','server_error']);
const fcmCodes = new Set(['UNREGISTERED','SENDER_ID_MISMATCH','INVALID_ARGUMENT','QUOTA_EXCEEDED','UNAVAILABLE','INTERNAL','THIRD_PARTY_AUTH_ERROR','PERMISSION_DENIED','UNAUTHENTICATED','NOT_FOUND','RESOURCE_EXHAUSTED']);
export function oauthCode(body: unknown): string {
  const value = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  return typeof value === 'string' && oauthCodes.has(value) ? value.toUpperCase() : 'HTTP_ERROR';
}
export function fcmCode(body: unknown): string {
  const error = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  if (!error || typeof error !== 'object') return 'HTTP_ERROR';
  const { details, status } = error as { details?: unknown; status?: unknown };
  if (Array.isArray(details)) {
    for (const detail of details) {
      const value = detail && typeof detail === 'object' ? (detail as { errorCode?: unknown }).errorCode : undefined;
      if (typeof value === 'string' && fcmCodes.has(value)) return value;
    }
  }
  return typeof status === 'string' && fcmCodes.has(status) ? status : 'HTTP_ERROR';
}
export function networkFailure(stage: 'OAUTH_NETWORK' | 'FCM_NETWORK', error: unknown): PushFailure {
  // Classify locally, but never propagate the message/name/stack themselves.
  const code = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError') ? 'TIMEOUT'
    : error instanceof Error && error.message.includes('Illegal invocation') ? 'ILLEGAL_INVOCATION'
    : error instanceof Error && error.message.includes('Invalid redirect value') ? 'INVALID_REDIRECT_MODE' : 'FETCH_FAILED';
  return new PushFailure(stage, code);
}
export function logPushFailure(failure: PushFailure, jobId: number, attempt: number, state: string): void {
  console.warn(JSON.stringify({ event: 'push_failure', jobId, attempt, state, stage: failure.stage, httpStatus: failure.httpStatus, code: failure.code, retryable: failure.retryable }));
}
export function logDispatchFailure(): void {
  console.error(JSON.stringify({ event: 'push_dispatch_failed', stage: 'DISPATCH', code: 'UNEXPECTED_FAILURE' }));
}
