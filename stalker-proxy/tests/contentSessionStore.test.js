import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { MemoryContentSessionStore, SqliteContentSessionStore } from '../src/services/contentSessionStore';

const session = (tokenHash, userId = 'user-1', createdAt = Date.now()) => ({
  tokenHash, userId, encryptedConnection: 'encrypted-payload',
  expiresAt: createdAt + 60_000, createdAt,
});

describe('content session stores', () => {
  it('keeps raw client tokens out of memory store values', async () => {
    const store = new MemoryContentSessionStore();
    await store.create(session('hash-only'));
    expect([...store.sessions.values()]).not.toContainEqual(expect.objectContaining({ token: 'raw-token' }));
    expect(await store.findByTokenHash('hash-only')).toEqual(expect.objectContaining({ tokenHash: 'hash-only' }));
  });

  it('shares SQLite sessions across store instances and removes expired rows', async () => {
    const db = new Database(':memory:');
    const first = new SqliteContentSessionStore(db);
    await first.create(session('hash-a', 'user-1', 100));
    await first.create(session('hash-b', 'user-1', 200));

    const second = new SqliteContentSessionStore(db);
    expect(await second.findByTokenHash('hash-a')).toEqual(expect.objectContaining({ userId: 'user-1' }));
    expect(await second.countByUserId('user-1', 60_150)).toBe(1);
    await second.deleteExpired(60_150);
    expect(await first.findByTokenHash('hash-a')).toBeNull();
    expect(await second.findByTokenHash('hash-b')).not.toBeNull();
    db.close();
  });

  it('deletes the oldest sessions when a user exceeds the limit', async () => {
    const db = new Database(':memory:');
    const store = new SqliteContentSessionStore(db);
    await store.create(session('old', 'user-1', 1));
    await store.create(session('new', 'user-1', 2));
    await store.deleteOldestByUserId('user-1', 1);
    expect(await store.findByTokenHash('old')).toBeNull();
    expect(await store.findByTokenHash('new')).not.toBeNull();
    db.close();
  });

  it('extends active sessions atomically without reviving expired sessions', async () => {
    const db = new Database(':memory:');
    const store = new SqliteContentSessionStore(db);
    await store.create(session('active', 'user-1', 1_000));
    await store.create(session('expired', 'user-1', 1_000));

    expect(await store.extendByTokenHash('active', 120_000, 30_000)).toBe(true);
    expect((await store.findByTokenHash('active')).expiresAt).toBe(120_000);
    expect(await store.extendByTokenHash('expired', 120_000, 70_000)).toBe(false);
    expect((await store.findByTokenHash('expired')).expiresAt).toBe(61_000);
    db.close();
  });
});
