const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { encryptToken, decryptToken } = require('../middleware/encrypt');
const { createContentSessionStore } = require('../services/contentSessionStore');

const TYPES = new Set(['xtream', 'm3u', 'stalker']);
const NO_STORE = { 'Cache-Control': 'no-store, private', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer' };
const fallbackStore = createContentSessionStore();
const boundedInt = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

function normalizeBaseUrl(value = process.env.CONTENT_BASE_URL || process.env.PLAYER_BASE) {
  const fallback = process.env.NODE_ENV === 'production' ? null : 'http://localhost:3201';
  const configured = value || fallback;
  if (!configured) throw new Error('CONTENT_BASE_URL is required');
  try {
    const url = new URL(configured);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    return url.origin;
  } catch {
    throw new Error('CONTENT_BASE_URL must be a valid HTTP or HTTPS origin');
  }
}

function normalizeConnection(input) {
  const connection = input || {};
  const config = connection.config || connection;
  const type = connection.type || config.type;
  const id = String(connection.id || '').trim();
  const label = String(connection.label || '').trim();
  if (!id || id.length > 128) throw new Error('Invalid connection id');
  if (label.length > 200) throw new Error('Invalid connection label');
  if (!TYPES.has(type)) throw new Error('Unsupported content session provider');
  if (type === 'xtream' && (!config.server || !config.user || !config.pass)) throw new Error('Xtream server, user, and password are required');
  if (type === 'm3u' && !config.url) throw new Error('M3U URL is required');
  if (type === 'stalker' && (!(config.server || config.portal) || !config.mac)) throw new Error('Stalker portal and MAC are required');
  let parsed;
  if (type === 'stalker') {
    parsed = new URL(config.server || config.portal);
  } else {
    parsed = new URL(type === 'xtream' ? config.server : config.url);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Provider URL must use HTTP or HTTPS');
  if (type === 'stalker') {
    return {
      id, type, label: label || `Stalker · ${config.mac.slice(-5)}`, config: {
        type: 'stalker',
        server: parsed.href.replace(/\/$/, ''),
        mac: String(config.mac).trim(),
        serial: config.serial || undefined,
        deviceId: config.deviceId || undefined,
        deviceId2: config.deviceId2 || undefined,
      },
    };
  }
  return {
    id, type, label: label || (type === 'xtream' ? `${config.user} - Xtream` : 'M3U Playlist'),
    config: type === 'xtream'
      ? { type, server: parsed.origin, user: String(config.user), pass: String(config.pass) }
      : { type, url: parsed.href },
  };
}

const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex');
const userId = user => String(user?.id || user?.sub || user?.email || user?.username || '');
const GUEST_ID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[A-Za-z0-9_-]{16,64})$/i;

function contentSessionAdEligible(session, auth) {
  const ownerId = String(session?.userId || '');
  if (ownerId.startsWith('guest:')) return true;
  if (!/^\d+$/.test(ownerId) || typeof auth?.getUser !== 'function') return false;
  try {
    const user = auth.getUser(Number(ownerId));
    return Boolean(user && !user.disabled && user.role === 'free');
  } catch {
    return false;
  }
}

function authenticate(req, auth) {
  const header = req.headers.authorization || '';
  const token = req.cookies?.sv_auth || (header.startsWith('Bearer ') ? header.slice(7) : null);
  if (token) {
    try {
      const user = auth.verifyToken(token);
      if (user) return user;
    } catch {}
  }
  const guestId = String(req.headers['x-guest-id'] || '').trim();
  return GUEST_ID_RE.test(guestId) ? { id: `guest:${guestId}`, guest: true } : null;
}

function createContentSessionRouter(deps) {
  const { auth, isUrlAllowed, connectionAccessService } = deps;
  const sqliteDb = deps.cache?.db && typeof deps.cache.db.exec === 'function' ? deps.cache.db : null;
  const store = deps.contentSessionStore || (deps.pool ? createContentSessionStore({ pool: deps.pool }) : sqliteDb ? createContentSessionStore({ db: sqliteDb }) : fallbackStore);
  const ttlMs = boundedInt(process.env.CONTENT_SESSION_TTL_MINUTES, 30, 5, 120) * 60_000;
  const maxPerUser = boundedInt(process.env.CONTENT_SESSION_MAX_PER_USER, 5, 1, 50);
  const router = express.Router();
  router.use('/content-session', rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false }));
  router.use('/content-session', (_req, res, next) => { res.set(NO_STORE); next(); });

  router.post('/content-session', async (req, res) => {
    const user = authenticate(req, auth);
    if (!user || !userId(user)) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const connection = normalizeConnection(req.body?.connection);
      if (connectionAccessService && !user.guest && user.id) {
        connectionAccessService.assertConnectionAllowed(user.id, connection.id);
      }
      const providerUrl = connection.type === 'm3u' ? connection.config.url : connection.config.server;
      if (isUrlAllowed && !(await isUrlAllowed(providerUrl))) return res.status(403).json({ error: 'Provider URL not allowed' });
      const uid = userId(user);
      await store.deleteExpired();
      const count = await store.countByUserId(uid);
      if (count >= maxPerUser) await store.deleteOldestByUserId(uid, count - maxPerUser + 1);
      const token = crypto.randomBytes(32).toString('base64url');
      const now = Date.now();
      await store.create({ tokenHash: tokenHash(token), userId: uid,
        encryptedConnection: encryptToken(JSON.stringify(connection)), expiresAt: now + ttlMs, createdAt: now });
      if (connectionAccessService && !user.guest && user.id) {
        connectionAccessService.recordSuccessfulConnectionUse(user.id, connection.id, now);
      }
      return res.json({ token, contentUrl: `${normalizeBaseUrl()}/content?token=${encodeURIComponent(token)}`, expiresAt: now + ttlMs });
    } catch (error) {
      if (error.code === 'connection_plan_locked' || error.status === 403) {
        return res.status(403).json({ error: error.message, code: error.code || 'connection_plan_locked' });
      }
      if (/CONTENT_BASE_URL|TOKEN_MASTER_KEY/.test(error.message)) return res.status(500).json({ error: 'Direct content is not configured' });
      if (/required|Invalid|Unsupported|URL/.test(error.message)) return res.status(400).json({ error: error.message });
      console.error('content-session creation failed:', error.message);
      return res.status(500).json({ error: 'Failed to create content session' });
    }
  });

  router.get('/content-session/validate', async (req, res) => {
    const token = String(req.query.token || '');
    if (!token) return res.status(400).json({ error: 'Missing token' });
    try {
      const hash = tokenHash(token);
      const session = await store.findByTokenHash(hash);
      if (!session) return res.status(404).json({ error: 'Content session not found' });
      if (session.expiresAt <= Date.now()) {
        await store.deleteByTokenHash(hash);
        return res.status(410).json({ error: 'Content session expired' });
      }
      let connection;
      try { connection = JSON.parse(decryptToken(session.encryptedConnection)); }
      catch { await store.deleteByTokenHash(hash); return res.status(404).json({ error: 'Content session invalid' }); }
      return res.json({
        connection,
        expiresAt: session.expiresAt,
        adEligible: contentSessionAdEligible(session, auth),
      });
    } catch (error) {
      console.error('content-session validation failed:', error.message);
      return res.status(500).json({ error: 'Failed to validate content session' });
    }
  });

  // The opaque token is the authorization for the HTTP content app. Refresh it
  // only while it is still valid so an expired or revoked session cannot return.
  router.post('/content-session/refresh', async (req, res) => {
    const token = String(req.body?.token || '');
    if (!token) return res.status(400).json({ error: 'Missing token', code: 'malformed' });
    try {
      const hash = tokenHash(token);
      const now = Date.now();
      const session = await store.findByTokenHash(hash);
      if (!session) return res.status(401).json({ error: 'Content session invalid', code: 'unauthorized' });
      if (session.expiresAt <= now) {
        await store.deleteByTokenHash(hash);
        return res.status(410).json({ error: 'Content session expired', code: 'expired' });
      }
      const expiresAt = now + ttlMs;
      const extended = await store.extendByTokenHash(hash, expiresAt, now);
      if (!extended) return res.status(410).json({ error: 'Content session expired', code: 'expired' });
      return res.json({ expiresAt });
    } catch (error) {
      console.error('content-session refresh failed:', error.message);
      return res.status(500).json({ error: 'Failed to refresh content session', code: 'server_failure' });
    }
  });

  router.delete('/content-session', async (req, res) => {
    const user = authenticate(req, auth);
    if (!user || !userId(user)) return res.status(401).json({ error: 'Unauthorized' });
    const token = String(req.body?.token || '');
    if (!token) return res.status(400).json({ error: 'Missing token' });
    const hash = tokenHash(token);
    const session = await store.findByTokenHash(hash);
    if (!session) return res.status(204).end();
    if (session.userId !== userId(user)) return res.status(403).json({ error: 'Forbidden' });
    await store.deleteByTokenHash(hash);
    return res.status(204).end();
  });
  return router;
}
const contentSessions = {
  clear: () => fallbackStore.sessions.clear(),
  get: token => fallbackStore.sessions.get(tokenHash(token)),
};
module.exports = { createContentSessionRouter, normalizeBaseUrl, normalizeConnection, tokenHash, contentSessions };
