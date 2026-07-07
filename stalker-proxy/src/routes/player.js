const crypto = require("crypto");

// In-memory token store: Map<token, { url, used, expiresAt }>
const tokens = new Map();
// In-memory playback session store: Map<playbackId, { url, expiresAt }>
const playbackSessions = new Map();
const TOKEN_TTL = 5 * 60 * 1000; // 5 minutes
const PLAYBACK_TTL = 2 * 60 * 60 * 1000; // 2 hours

function cleanupExpiredEntries() {
  const now = Date.now();
  for (const [key, val] of tokens) {
    if (val.expiresAt <= now) tokens.delete(key);
  }
  for (const [key, val] of playbackSessions) {
    if (val.expiresAt <= now) playbackSessions.delete(key);
  }
}

// Cleanup expired entries every 60s
setInterval(cleanupExpiredEntries, 60_000);

async function resolvePlayableUrl(rawUrl, fetchImpl = fetch) {
  let finalUrl = rawUrl;
  const streamType = finalUrl.endsWith(".m3u8") || finalUrl.endsWith(".ts") ? "hls" : "direct";

  if (finalUrl.endsWith(".ts")) {
    finalUrl = finalUrl.replace(/\.ts$/, ".m3u8");
  }

  try {
    const getRes = await fetchImpl(finalUrl, { redirect: "follow", signal: AbortSignal.timeout(8000) });
    if (getRes.url && getRes.url !== finalUrl) finalUrl = getRes.url;
    getRes.body?.cancel?.();
    // Provider endpoints are HTTP-only; the browser/player layer decides whether to proxy.
    finalUrl = finalUrl.replace(/^https:/, "http:");
  } catch {
    // Fall through with the best URL we have.
  }

  return { url: finalUrl, type: streamType };
}

function createPlayerRouter(deps) {
  const { auth } = deps;
  const router = require("express").Router();

  // Generate a one-time play token — requires auth
  router.post("/play-token", (req, res) => {
    try {
      // Verify auth
      const token = req.cookies?.sv_auth || (req.headers.authorization?.slice(7));
      if (!token) return res.status(401).json({ error: "Unauthorized" });
      const user = auth.verifyToken(token);
      if (!user) return res.status(401).json({ error: "Invalid token" });

      const { url } = req.body;
      if (!url) return res.status(400).json({ error: "Missing stream URL" });

      // Validate URL is HTTP (must be provider HTTP stream)
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        return res.status(400).json({ error: "Invalid stream URL" });
      }

      const id = crypto.randomBytes(24).toString("hex");
      tokens.set(id, { url, used: false, expiresAt: Date.now() + TOKEN_TTL });

      const PLAYER_BASE = process.env.PLAYER_BASE || "http://40.233.113.76";
      res.json({
        token: id,
        playerUrl: `${PLAYER_BASE}/player?token=${id}`,
      });
    } catch (e) {
      console.error("play-token error:", e);
      res.status(500).json({ error: "Failed to generate token" });
    }
  });

  // Validate and consume a play token — called from the player page
  router.get("/validate-token", async (req, res) => {
    const { token } = req.query;
    if (!token) { res.status(400).json({ error: "Missing token" }); return; }

    const entry = tokens.get(token);
    if (!entry) { res.status(404).json({ error: "Token not found" }); return; }
    if (entry.expiresAt <= Date.now()) {
      tokens.delete(token);
      res.status(410).json({ error: "Token expired" }); return;
    }
    if (entry.used) { res.status(410).json({ error: "Token already used" }); return; }

    entry.used = true;
    tokens.delete(token); // Clean up immediately

    const playbackId = crypto.randomBytes(24).toString("hex");
    playbackSessions.set(playbackId, {
      url: entry.url,
      expiresAt: Date.now() + PLAYBACK_TTL,
    });

    const resolved = await resolvePlayableUrl(entry.url, deps.fetch);
    res.json({ url: resolved.url, type: resolved.type, playbackId });
  });

  // Refresh a previously validated playback session with a fresh upstream URL.
  router.get("/refresh-playback", async (req, res) => {
    const { playbackId } = req.query;
    if (!playbackId) { res.status(400).json({ error: "Missing playbackId" }); return; }

    const entry = playbackSessions.get(playbackId);
    if (!entry) { res.status(404).json({ error: "Playback session not found" }); return; }
    if (entry.expiresAt <= Date.now()) {
      playbackSessions.delete(playbackId);
      res.status(410).json({ error: "Playback session expired" }); return;
    }

    try {
      const resolved = await resolvePlayableUrl(entry.url, deps.fetch);
      res.json({ url: resolved.url, type: resolved.type, playbackId });
    } catch (e) {
      res.status(502).json({ error: e?.message || "Failed to refresh playback" });
    }
  });

  return router;
}

module.exports = { createPlayerRouter, tokens, playbackSessions };
