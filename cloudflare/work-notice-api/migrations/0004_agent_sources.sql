-- Keep the Telegram confirmation truthful; null retains legacy heartbeat semantics.
-- No notification, pairing, monitoring, encryption, or push columns are changed.
ALTER TABLE agents ADD COLUMN enabled_sources TEXT;
