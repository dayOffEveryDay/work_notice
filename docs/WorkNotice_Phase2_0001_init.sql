-- Work Notice 第二階段，D1 / SQLite schema
-- 事件資料只保留 Telegram 通知識別資訊；不保存訊息正文或發送者。
CREATE TABLE IF NOT EXISTS agents (
  device_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT 'Windows PC',
  reported_mode TEXT NOT NULL DEFAULT 'STANDBY',
  listener_status TEXT NOT NULL DEFAULT 'ERROR',
  notification_permission TEXT NOT NULL DEFAULT 'UNKNOWN',
  telegram_source_confirmed INTEGER NOT NULL DEFAULT 0,
  last_session_id TEXT,
  agent_version TEXT,
  last_seen_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_events (
  device_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  source TEXT NOT NULL,
  aumid TEXT NOT NULL,
  notification_id TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  result TEXT NOT NULL,
  should_notify INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_alert_events_received_at
ON alert_events(received_at_ms);

CREATE TABLE IF NOT EXISTS alert_settings (
  device_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  mode TEXT NOT NULL DEFAULT 'UNTIL_MANUALLY_DISABLED',
  expires_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS request_nonces (
  device_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (device_id, nonce)
);
CREATE INDEX IF NOT EXISTS idx_request_nonces_expires
ON request_nonces(expires_at_ms);

CREATE TABLE IF NOT EXISTS agent_status_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  status TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL
);
