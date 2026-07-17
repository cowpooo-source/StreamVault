class MemoryContentSessionStore {
  constructor() { this.sessions = new Map(); }
  async create(value) { this.sessions.set(value.tokenHash, { ...value }); }
  async findByTokenHash(hash) { return this.sessions.get(hash) || null; }
  async extendByTokenHash(hash, expiresAt, now = Date.now()) {
    const session = this.sessions.get(hash);
    if (!session || session.expiresAt <= now) return false;
    session.expiresAt = expiresAt;
    return true;
  }
  async deleteByTokenHash(hash) { return this.sessions.delete(hash); }
  async deleteByUserId(userId) { for (const [key, value] of this.sessions) if (value.userId === userId) this.sessions.delete(key); }
  async deleteExpired(now = Date.now()) { for (const [key, value] of this.sessions) if (value.expiresAt <= now) this.sessions.delete(key); }
  async countByUserId(userId, now = Date.now()) {
    await this.deleteExpired(now);
    return [...this.sessions.values()].filter(value => value.userId === userId).length;
  }
  async deleteOldestByUserId(userId, count) {
    const matches = [...this.sessions.values()].filter(v => v.userId === userId).sort((a, b) => a.createdAt - b.createdAt).slice(0, count);
    for (const value of matches) this.sessions.delete(value.tokenHash);
  }
}

class PostgresContentSessionStore {
  constructor(pool) {
    this.pool = pool;
    this.ready = this.pool.query(`
      CREATE TABLE IF NOT EXISTS content_sessions (
        token_hash VARCHAR(64) PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        connection_payload TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS content_sessions_user_id_idx ON content_sessions (user_id);
      CREATE INDEX IF NOT EXISTS content_sessions_expires_at_idx ON content_sessions (expires_at)
    `);
  }
  async create(value) {
    await this.ready;
    await this.pool.query('INSERT INTO content_sessions (token_hash, user_id, connection_payload, expires_at, created_at) VALUES ($1, $2, $3, $4, $5)',
      [value.tokenHash, value.userId, value.encryptedConnection, value.expiresAt, value.createdAt]);
  }
  async findByTokenHash(hash) {
    await this.ready;
    const result = await this.pool.query('SELECT token_hash, user_id, connection_payload, expires_at, created_at FROM content_sessions WHERE token_hash = $1', [hash]);
    const row = result.rows[0];
    return row ? { tokenHash: row.token_hash, userId: row.user_id, encryptedConnection: row.connection_payload,
      expiresAt: Number(row.expires_at), createdAt: Number(row.created_at) } : null;
  }
  async extendByTokenHash(hash, expiresAt, now = Date.now()) {
    await this.ready;
    const result = await this.pool.query(
      'UPDATE content_sessions SET expires_at = $2 WHERE token_hash = $1 AND expires_at > $3',
      [hash, expiresAt, now],
    );
    return result.rowCount > 0;
  }
  async deleteByTokenHash(hash) { await this.ready; await this.pool.query('DELETE FROM content_sessions WHERE token_hash = $1', [hash]); }
  async deleteByUserId(userId) { await this.ready; await this.pool.query('DELETE FROM content_sessions WHERE user_id = $1', [userId]); }
  async deleteExpired(now = Date.now()) { await this.ready; await this.pool.query('DELETE FROM content_sessions WHERE expires_at <= $1', [now]); }
  async countByUserId(userId, now = Date.now()) {
    await this.ready;
    const result = await this.pool.query('SELECT COUNT(*) AS count FROM content_sessions WHERE user_id = $1 AND expires_at > $2', [userId, now]);
    return Number(result.rows[0]?.count || 0);
  }
  async deleteOldestByUserId(userId, count) {
    await this.ready;
    if (count > 0) await this.pool.query('DELETE FROM content_sessions WHERE token_hash IN (SELECT token_hash FROM content_sessions WHERE user_id = $1 ORDER BY created_at ASC LIMIT $2)', [userId, count]);
  }
}

class SqliteContentSessionStore {
  constructor(db) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS content_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        connection_payload TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS content_sessions_user_id_idx ON content_sessions (user_id);
      CREATE INDEX IF NOT EXISTS content_sessions_expires_at_idx ON content_sessions (expires_at);
    `);
    this.insert = this.db.prepare('INSERT INTO content_sessions (token_hash, user_id, connection_payload, expires_at, created_at) VALUES (?, ?, ?, ?, ?)');
    this.find = this.db.prepare('SELECT token_hash, user_id, connection_payload, expires_at, created_at FROM content_sessions WHERE token_hash = ?');
    this.extend = this.db.prepare('UPDATE content_sessions SET expires_at = ? WHERE token_hash = ? AND expires_at > ?');
    this.deleteOne = this.db.prepare('DELETE FROM content_sessions WHERE token_hash = ?');
    this.deleteUser = this.db.prepare('DELETE FROM content_sessions WHERE user_id = ?');
    this.deleteExpiredStatement = this.db.prepare('DELETE FROM content_sessions WHERE expires_at <= ?');
    this.count = this.db.prepare('SELECT COUNT(*) AS count FROM content_sessions WHERE user_id = ? AND expires_at > ?');
    this.oldest = this.db.prepare('SELECT token_hash FROM content_sessions WHERE user_id = ? ORDER BY created_at ASC LIMIT ?');
  }
  async create(value) { this.insert.run(value.tokenHash, value.userId, value.encryptedConnection, value.expiresAt, value.createdAt); }
  async findByTokenHash(hash) {
    const row = this.find.get(hash);
    return row ? { tokenHash: row.token_hash, userId: row.user_id, encryptedConnection: row.connection_payload,
      expiresAt: Number(row.expires_at), createdAt: Number(row.created_at) } : null;
  }
  async extendByTokenHash(hash, expiresAt, now = Date.now()) { return this.extend.run(expiresAt, hash, now).changes > 0; }
  async deleteByTokenHash(hash) { return this.deleteOne.run(hash).changes > 0; }
  async deleteByUserId(userId) { this.deleteUser.run(userId); }
  async deleteExpired(now = Date.now()) { this.deleteExpiredStatement.run(now); }
  async countByUserId(userId, now = Date.now()) { return Number(this.count.get(userId, now)?.count || 0); }
  async deleteOldestByUserId(userId, count) {
    if (count <= 0) return;
    const rows = this.oldest.all(userId, count);
    const remove = this.db.transaction(tokens => tokens.forEach(row => this.deleteOne.run(row.token_hash)));
    remove(rows);
  }
}

function createContentSessionStore({ pool, db } = {}) {
  if (pool) return new PostgresContentSessionStore(pool);
  if (db) return new SqliteContentSessionStore(db);
  return new MemoryContentSessionStore();
}
module.exports = { MemoryContentSessionStore, PostgresContentSessionStore, SqliteContentSessionStore, createContentSessionStore };
