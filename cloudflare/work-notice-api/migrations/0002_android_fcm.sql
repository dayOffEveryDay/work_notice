-- Additive phase-three schema. Never edit the deployed 0001 migration.
CREATE TABLE android_devices (
  mobile_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  bearer_hash TEXT NOT NULL UNIQUE,
  token_version INTEGER NOT NULL DEFAULT 1,
  revoked_at_ms INTEGER,
  fcm_cipher TEXT,
  fcm_version INTEGER NOT NULL DEFAULT 0,
  offline_alerts INTEGER NOT NULL DEFAULT 1 CHECK(offline_alerts IN (0,1)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE UNIQUE INDEX android_one_active_per_agent ON android_devices(device_id) WHERE revoked_at_ms IS NULL;
CREATE TABLE mobile_pairings (
  code_hash TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  claimed_at_ms INTEGER,
  claimed_mobile_id TEXT,
  claim_id TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX pairing_expiry ON mobile_pairings(expires_at_ms);
CREATE TABLE push_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  mobile_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  push_type TEXT NOT NULL CHECK(push_type IN ('WORK_ALERT','WINDOWS_OFFLINE')),
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','SENT_TO_FCM','RETRY','PERMANENT_FAILURE','EXPIRED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  next_attempt_ms INTEGER NOT NULL,
  lease_until_ms INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  last_error TEXT,
  sent_at_ms INTEGER,
  UNIQUE(device_id,event_id,push_type)
);
CREATE INDEX push_due ON push_jobs(state,next_attempt_ms,expires_at_ms);
CREATE TABLE mobile_acks (
  mobile_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('RECEIVED','RINGING','STOPPED','NOTIFICATION_FALLBACK')),
  received_at_ms INTEGER NOT NULL,
  PRIMARY KEY(mobile_id,event_id,status)
);
CREATE TABLE mobile_rate_limits (
  bucket TEXT NOT NULL,
  window_ms INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  PRIMARY KEY(bucket,window_ms)
);
-- Durable outbox insertion is in the same SQLite transaction as the new event.
CREATE TRIGGER enqueue_mobile_alert AFTER INSERT ON alert_events
WHEN NEW.result='ACCEPTED' AND NEW.should_notify=1
BEGIN
  INSERT OR IGNORE INTO push_jobs(device_id,mobile_id,event_id,push_type,created_at_ms,expires_at_ms,next_attempt_ms)
  SELECT NEW.device_id,mobile_id,NEW.event_id,'WORK_ALERT',NEW.received_at_ms,
    MIN(NEW.occurred_at_ms+120000,NEW.received_at_ms+120000),NEW.received_at_ms
  FROM android_devices WHERE device_id=NEW.device_id AND revoked_at_ms IS NULL AND fcm_cipher IS NOT NULL;
END;
CREATE TRIGGER enqueue_mobile_offline AFTER INSERT ON agent_status_transitions
WHEN NEW.status='OFFLINE'
BEGIN
  INSERT OR IGNORE INTO push_jobs(device_id,mobile_id,event_id,push_type,created_at_ms,expires_at_ms,next_attempt_ms)
  SELECT NEW.device_id,mobile_id,'offline-'||NEW.id,'WINDOWS_OFFLINE',NEW.observed_at_ms,NEW.observed_at_ms+120000,NEW.observed_at_ms
  FROM android_devices WHERE device_id=NEW.device_id AND revoked_at_ms IS NULL AND fcm_cipher IS NOT NULL AND offline_alerts=1
  -- Both running modes send heartbeats; an unexpected loss in either mode is actionable.
  AND EXISTS(SELECT 1 FROM agents WHERE device_id=NEW.device_id AND reported_mode IN ('MONITORING','STANDBY'));
END;
-- Disabling is irreversible for pending jobs, even if reception is enabled again later.
CREATE TRIGGER cancel_disabled_pushes AFTER UPDATE ON alert_settings
WHEN NEW.enabled=0
BEGIN
  UPDATE push_jobs SET state='EXPIRED',last_error='DISABLED'
  WHERE device_id=NEW.device_id AND push_type='WORK_ALERT' AND state IN ('PENDING','RETRY');
END;
