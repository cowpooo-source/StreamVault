-- Migration: Add playback_sessions table
CREATE TABLE IF NOT EXISTS playback_sessions (
  session_id TEXT PRIMARY KEY,
  user_id INTEGER,
  guest_id TEXT,
  connection_id TEXT,
  item_id TEXT,
  item_type TEXT,
  item_name TEXT,
  group_name TEXT,
  started_at INTEGER,
  last_seen_at INTEGER,
  ended_at INTEGER,
  watched_seconds INTEGER DEFAULT 0,
  media_duration INTEGER,
  position INTEGER,
  completed BOOLEAN DEFAULT 0,
  device_id TEXT
);
