-- StreamVault D1 schema: permanent content storage

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  label TEXT,
  config TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE content_items (
  id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  logo TEXT,
  group_name TEXT,
  url TEXT,
  num INTEGER,
  epg_id TEXT,
  year TEXT,
  rating TEXT,
  stalker_cmd TEXT,
  extra TEXT,
  PRIMARY KEY (connection_id, type, id)
);

CREATE TABLE stalker_categories (
  id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  section TEXT NOT NULL,
  title TEXT NOT NULL,
  count INTEGER DEFAULT 0,
  PRIMARY KEY (connection_id, section, id)
);

CREATE TABLE favorites (
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_type TEXT NOT NULL,
  item_data TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, profile_id, item_type, item_id)
);

CREATE TABLE watch_history (
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  name TEXT,
  url TEXT,
  logo TEXT,
  group_name TEXT,
  type TEXT NOT NULL,
  position REAL DEFAULT 0,
  duration REAL DEFAULT 0,
  timestamp INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id)
);

CREATE TABLE user_preferences (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE sync_meta (
  user_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  data_type TEXT NOT NULL,
  last_synced INTEGER NOT NULL,
  item_count INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, connection_id, data_type)
);
