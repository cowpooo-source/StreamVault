CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  plan TEXT DEFAULT 'free' CHECK (plan IN ('free','pro','family','lifetime')),
  stripe_id TEXT,
  stripe_subscription_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE servers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('jellyfin','plex')),
  name TEXT NOT NULL,
  base_url_enc BYTEA NOT NULL,
  access_token_enc BYTEA NOT NULL,
  remote_user_id_enc BYTEA,
  last_seen TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  avatar_url TEXT,
  pin_hash TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE watchlist (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  title_enc BYTEA,
  type TEXT CHECK (type IN ('movie','series','channel')),
  added_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(profile_id, server_id, item_id)
);

CREATE TABLE watch_progress (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  position_ms BIGINT NOT NULL DEFAULT 0,
  duration_ms BIGINT,
  provider_updated_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(profile_id, server_id, item_id)
);

CREATE INDEX idx_watch_progress_profile ON watch_progress(profile_id);
CREATE INDEX idx_watchlist_profile ON watchlist(profile_id);