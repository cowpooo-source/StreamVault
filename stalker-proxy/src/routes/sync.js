const { encryptToken } = require('../middleware/encrypt');
const auth = require('../auth');

function createSyncRouter(pool) {
  const router = require('express').Router({ mergeParams: true });

  // GET /sync/watch-progress
  router.get('/watch-progress', auth.requireAuth, async (req, res) => {
    const userId = req.user.id;
    const { rows } = await pool.query(
      `SELECT item_id, position_ms, duration_ms, provider_updated_at, synced_at
       FROM watch_progress WHERE user_id = $1 ORDER BY synced_at DESC`,
      [userId]
    );
    res.json({ progress: rows });
  });

  // POST /sync/watch-progress
  // Upserts watch progress with conflict resolution (newest provider_updated_at wins)
  router.post('/watch-progress', auth.requireAuth, async (req, res) => {
    const userId = req.user.id;
    const { serverId, itemId, positionMs, providerUpdatedAt } = req.body;
    const { rows } = await pool.query(`
      INSERT INTO watch_progress (id, user_id, server_id, item_id, position_ms, provider_updated_at, synced_at)
      VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5, NOW())
      ON CONFLICT (user_id, server_id, item_id) DO UPDATE
        SET position_ms = EXCLUDED.position_ms,
            provider_updated_at = EXCLUDED.provider_updated_at,
            synced_at = NOW()
        WHERE watch_progress.provider_updated_at < EXCLUDED.provider_updated_at
      RETURNING *
    `, [userId, serverId, itemId, positionMs, providerUpdatedAt]);
    res.json({ updated: rows[0] });
  });

  // GET /sync/watchlist
  router.get('/watchlist', auth.requireAuth, async (req, res) => {
    const userId = req.user.id;
    const { rows } = await pool.query(
      `SELECT id, item_id, title_enc, type, added_at FROM watchlist WHERE user_id = $1`,
      [userId]
    );
    res.json({ watchlist: rows });
  });

  // POST /sync/watchlist
  router.post('/watchlist', auth.requireAuth, async (req, res) => {
    const userId = req.user.id;
    const { serverId, itemId, title, type } = req.body;
    const titleEnc = encryptToken(title);
    const { rows } = await pool.query(`
      INSERT INTO watchlist (id, user_id, server_id, item_id, title_enc, type)
      VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5)
      ON CONFLICT (user_id, server_id, item_id) DO NOTHING
      RETURNING *
    `, [userId, serverId, itemId, titleEnc, type]);
    res.status(201).json({ added: rows[0] });
  });

  return router;
}

module.exports = { createSyncRouter };