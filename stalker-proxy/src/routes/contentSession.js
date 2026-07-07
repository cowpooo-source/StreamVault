const crypto = require('crypto');
const express = require('express');

const contentSessions = new Map();
const CONTENT_SESSION_TTL = 30 * 60 * 1000;
const DIRECT_PROVIDER_TYPES = new Set(['xtream', 'm3u']);

function cleanupExpiredContentSessions(now = Date.now()) {
  for (const [token, session] of contentSessions) {
    if (session.expiresAt <= now) contentSessions.delete(token);
  }
}

const cleanupTimer = setInterval(cleanupExpiredContentSessions, 60_000);
if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();

function normalizeConnection(input) {
  const connection = input || {};
  const config = connection.config || connection;
  const type = connection.type || config.type;

  if (!connection.id) throw new Error('Missing connection id');
  if (!DIRECT_PROVIDER_TYPES.has(type)) throw new Error('Unsupported content session provider');

  return {
    id: String(connection.id),
    type,
    label: connection.label || (type === 'xtream' ? `${config.user || 'Xtream'} - Xtream` : 'M3U Playlist'),
    config: { ...config, type },
  };
}

function contentBaseUrl() {
  return process.env.CONTENT_BASE_URL || process.env.PLAYER_BASE || 'http://40.233.113.76';
}

function createContentSessionRouter(deps) {
  const { auth } = deps;
  const router = express.Router();

  router.post('/content-session', (req, res) => {
    try {
      const authHeader = req.headers.authorization || '';
      const authToken = req.cookies?.sv_auth || (authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null);
      if (!authToken) return res.status(401).json({ error: 'Unauthorized' });

      const user = auth.verifyToken(authToken);
      if (!user) return res.status(401).json({ error: 'Invalid token' });

      let connection;
      try {
        connection = normalizeConnection(req.body?.connection);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }

      const token = crypto.randomBytes(24).toString('hex');
      const expiresAt = Date.now() + CONTENT_SESSION_TTL;
      contentSessions.set(token, {
        userId: user.id,
        connection,
        expiresAt,
      });

      return res.json({
        token,
        contentUrl: `${contentBaseUrl()}/content?token=${token}`,
        expiresAt,
      });
    } catch (e) {
      console.error('content-session error:', e);
      return res.status(500).json({ error: 'Failed to create content session' });
    }
  });

  router.get('/content-session/validate', (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Missing token' });

    const session = contentSessions.get(token);
    if (!session) return res.status(404).json({ error: 'Content session not found' });
    if (session.expiresAt <= Date.now()) {
      contentSessions.delete(token);
      return res.status(410).json({ error: 'Content session expired' });
    }

    return res.json({
      connection: session.connection,
      expiresAt: session.expiresAt,
    });
  });

  return router;
}

module.exports = {
  createContentSessionRouter,
  contentSessions,
  cleanupExpiredContentSessions,
  normalizeConnection,
};