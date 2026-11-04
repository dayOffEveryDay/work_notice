export interface AgentRow {
  device_id: string; reported_mode: string; listener_status: string; notification_permission: string;
  telegram_source_confirmed: number; last_seen_at_ms: number | null; last_session_id: string | null;
  agent_version: string | null; enabled_sources?: string | null;
}
export function effectiveStatus(agent: AgentRow | null, now: number): string {
  if (!agent || agent.last_seen_at_ms === null) return 'UNKNOWN';
  if (agent.reported_mode === 'STOPPED_BY_USER') return 'STOPPED_BY_USER';
  if (now - agent.last_seen_at_ms > 180000) return 'OFFLINE';
  if (agent.listener_status !== 'READY' || agent.notification_permission !== 'ALLOWED' || !(agent.enabled_sources == null ? agent.telegram_source_confirmed : agent.enabled_sources !== '[]')) return 'DEGRADED';
  return agent.reported_mode === 'STANDBY' ? 'STANDBY' : 'MONITORING';
}
export function ensureAgent(db: D1Database, id: string, now: number): D1PreparedStatement {
  return db.prepare('INSERT INTO agents(device_id,created_at_ms,updated_at_ms) VALUES (?,?,?) ON CONFLICT(device_id) DO NOTHING').bind(id, now, now);
}
// A single INSERT...SELECT checks the latest transition inside D1's transaction,
// so overlapping cron / heartbeat requests cannot append duplicate sustained states.
export function transition(db: D1Database, now: number, id: string | null): D1PreparedStatement {
  return db.prepare(`WITH statuses AS (
    SELECT device_id, CASE
      WHEN last_seen_at_ms IS NULL THEN 'UNKNOWN'
      WHEN reported_mode='STOPPED_BY_USER' THEN 'STOPPED_BY_USER'
      WHEN last_seen_at_ms < ? THEN 'OFFLINE'
      WHEN listener_status!='READY' OR notification_permission!='ALLOWED' OR (CASE WHEN enabled_sources IS NULL THEN telegram_source_confirmed=0 ELSE enabled_sources='[]' END) THEN 'DEGRADED'
      WHEN reported_mode='STANDBY' THEN 'STANDBY' ELSE 'MONITORING' END AS status FROM agents)
    INSERT INTO agent_status_transitions(device_id,status,observed_at_ms)
    SELECT device_id,status,? FROM statuses
    WHERE (? IS NULL OR device_id=?) AND status != COALESCE(
      (SELECT status FROM agent_status_transitions AS history WHERE history.device_id=statuses.device_id ORDER BY id DESC LIMIT 1),'')`)
    .bind(now - 180000, now, id, id);
}
export async function maintain(db: D1Database, now: number): Promise<void> {
  await db.batch([transition(db, now, null),
    db.prepare('DELETE FROM request_nonces WHERE expires_at_ms <= ?').bind(now),
    db.prepare('DELETE FROM alert_events WHERE received_at_ms < ?').bind(now - 7 * 86400000)]);
}
