CREATE TABLE IF NOT EXISTS content_sessions (
  token_hash VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  connection_payload TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS content_sessions_user_id_idx ON content_sessions (user_id);
CREATE INDEX IF NOT EXISTS content_sessions_expires_at_idx ON content_sessions (expires_at);
