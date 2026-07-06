const crypto = require("crypto");

// In-memory token store: Map<token, { url, used, expiresAt }>
const tokens = new Map();
const TOKEN_TTL = 5 * 60 * 1000; // 5 minutes

// Cleanup expired tokens every 60s
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of tokens) {
    if (val.expiresAt <= now) tokens.delete(key);
  }
}, 60_000);

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

      const PLAYER_BASE = process.env.PLAYER_BASE || "http://play.portalheaven.stream";
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

    // Resolve redirects — browser video elements can't follow 302 for media.
    // Xtream .ts URLs redirect with a token; swap to .m3u8 for HLS playback.
    let finalUrl = entry.url;
    let streamType = finalUrl.endsWith(".m3u8") || finalUrl.endsWith(".ts") ? "hls" : "direct";
    if (finalUrl.endsWith(".ts")) {
      finalUrl = finalUrl.replace(/\.ts$/, ".m3u8");
    }
    try {
      const getRes = await fetch(finalUrl, { redirect: "follow", signal: AbortSignal.timeout(8000) });
      if (getRes.url !== finalUrl) finalUrl = getRes.url;
      getRes.body?.cancel();
      // Force back to HTTP — stream servers don't speak TLS
      finalUrl = finalUrl.replace(/^https:/, "http:");
    } catch {} // fall through with original URL

    res.json({ url: finalUrl, type: streamType });
  });

  return router;
}

module.exports = { createPlayerRouter, tokens };
