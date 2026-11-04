CREATE TABLE monitoring_settings (
 device_id TEXT PRIMARY KEY,
 owner_mobile_id TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('OFF','IMMEDIATE','SCHEDULED')),
 starts_at_ms INTEGER,
 session_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0),
 urgent_consent INTEGER NOT NULL CHECK(urgent_consent IN (0,1)),
 last_command_id TEXT NOT NULL,
 updated_at_ms INTEGER NOT NULL
);
CREATE TABLE monitoring_commands (
 device_id TEXT NOT NULL, command_id TEXT NOT NULL, mobile_id TEXT NOT NULL,
 request_hash TEXT NOT NULL, expected_revision INTEGER NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('OFF','IMMEDIATE','SCHEDULED')),
 starts_at_ms INTEGER, session_id TEXT NOT NULL, urgent_consent INTEGER NOT NULL,
 created_at_ms INTEGER NOT NULL, applied_revision INTEGER,
 PRIMARY KEY(device_id,command_id)
);
ALTER TABLE push_jobs ADD COLUMN monitoring_session_id TEXT;
ALTER TABLE push_jobs ADD COLUMN monitoring_revision INTEGER;
ALTER TABLE push_jobs ADD COLUMN occurred_at_ms INTEGER;
-- A failed CAS is recorded as applied_revision NULL. EVERY side effect below is
-- conditional on this command actually winning, not on "batch did not throw".
CREATE TRIGGER apply_monitoring_command AFTER INSERT ON monitoring_commands
BEGIN
 INSERT INTO monitoring_settings(device_id,owner_mobile_id,mode,starts_at_ms,session_id,revision,urgent_consent,last_command_id,updated_at_ms)
 SELECT NEW.device_id,NEW.mobile_id,NEW.mode,NEW.starts_at_ms,NEW.session_id,NEW.expected_revision+1,NEW.urgent_consent,NEW.command_id,NEW.created_at_ms
 WHERE NEW.expected_revision=COALESCE((SELECT revision FROM monitoring_settings WHERE device_id=NEW.device_id),0)
 AND EXISTS(SELECT 1 FROM android_devices WHERE mobile_id=NEW.mobile_id AND device_id=NEW.device_id AND revoked_at_ms IS NULL)
 ON CONFLICT(device_id) DO UPDATE SET owner_mobile_id=excluded.owner_mobile_id,mode=excluded.mode,starts_at_ms=excluded.starts_at_ms,
 session_id=excluded.session_id,revision=excluded.revision,urgent_consent=excluded.urgent_consent,last_command_id=excluded.last_command_id,updated_at_ms=excluded.updated_at_ms
 WHERE monitoring_settings.revision=NEW.expected_revision;
 UPDATE monitoring_commands SET applied_revision=(SELECT revision FROM monitoring_settings WHERE device_id=NEW.device_id AND last_command_id=NEW.command_id)
 WHERE device_id=NEW.device_id AND command_id=NEW.command_id;
 UPDATE alert_settings SET enabled=0,updated_at_ms=NEW.created_at_ms WHERE device_id=NEW.device_id
 AND EXISTS(SELECT 1 FROM monitoring_commands WHERE device_id=NEW.device_id AND command_id=NEW.command_id AND applied_revision IS NOT NULL);
 UPDATE push_jobs SET state='EXPIRED',last_error='MONITORING_REPLACED' WHERE device_id=NEW.device_id AND push_type='WORK_ALERT' AND state IN ('PENDING','RETRY')
 AND EXISTS(SELECT 1 FROM monitoring_commands WHERE device_id=NEW.device_id AND command_id=NEW.command_id AND applied_revision IS NOT NULL);
END;
-- Protect the legacy projection even when a legacy request races with adoption.
CREATE TRIGGER protect_monitoring_legacy BEFORE UPDATE ON alert_settings
WHEN NEW.enabled=1 AND EXISTS(SELECT 1 FROM monitoring_settings WHERE device_id=NEW.device_id)
BEGIN
 SELECT RAISE(ABORT,'monitoring_api_required');
END;
CREATE TRIGGER revoke_monitoring AFTER UPDATE OF revoked_at_ms ON android_devices
WHEN NEW.revoked_at_ms IS NOT NULL AND OLD.revoked_at_ms IS NULL
BEGIN
 UPDATE monitoring_settings SET mode='OFF',starts_at_ms=NULL,urgent_consent=0,revision=revision+1,updated_at_ms=NEW.revoked_at_ms
 WHERE device_id=NEW.device_id AND owner_mobile_id=NEW.mobile_id;
 UPDATE push_jobs SET state='EXPIRED',last_error='REVOKED' WHERE mobile_id=NEW.mobile_id AND push_type='WORK_ALERT' AND state IN ('PENDING','RETRY');
END;
DROP TRIGGER enqueue_mobile_alert;
CREATE TRIGGER enqueue_mobile_alert AFTER INSERT ON alert_events
WHEN NEW.result='ACCEPTED' AND NEW.should_notify=1
BEGIN
 INSERT OR IGNORE INTO push_jobs(device_id,mobile_id,event_id,push_type,created_at_ms,expires_at_ms,next_attempt_ms,monitoring_session_id,monitoring_revision,occurred_at_ms)
 SELECT NEW.device_id,m.mobile_id,NEW.event_id,'WORK_ALERT',NEW.received_at_ms,MIN(NEW.occurred_at_ms+120000,NEW.received_at_ms+120000),NEW.received_at_ms,s.session_id,s.revision,NEW.occurred_at_ms
 FROM android_devices m LEFT JOIN monitoring_settings s ON s.device_id=m.device_id
 WHERE m.device_id=NEW.device_id AND m.revoked_at_ms IS NULL AND m.fcm_cipher IS NOT NULL
 AND (s.device_id IS NULL OR (s.owner_mobile_id=m.mobile_id AND s.mode!='OFF' AND s.starts_at_ms<=NEW.received_at_ms AND NEW.occurred_at_ms>=s.starts_at_ms));
END;
