// /api/catalog/* handlers — persistent content storage via D1
import { jsonResponse, errorResponse } from "../utils/cors.js";
import { getGuestId, ensureUser } from "../utils/auth.js";

function authGuard(request) {
  const guestId = getGuestId(request);
  if (!guestId) return { error: errorResponse("Missing X-Guest-Id header", 401) };
  return { guestId };
}

// ── PUT /api/catalog/content — batch upsert content items
export async function handlePutContent(request, env) {
  const { guestId, error } = authGuard(request);
  if (error) return error;
  await ensureUser(env.SV_DB, guestId);

  const { connectionId, type, items } = await request.json();
  if (!connectionId || !type || !Array.isArray(items)) {
    return errorResponse("connectionId, type, and items[] required", 400);
  }

  // Delete existing items for this connection+type, then batch insert
  const db = env.SV_DB;
  const stmts = [
    db.prepare("DELETE FROM content_items WHERE connection_id = ? AND type = ?")
      .bind(connectionId, type),
  ];

  for (const item of items) {
    stmts.push(
      db.prepare(
        `INSERT INTO content_items (id, connection_id, type, name, logo, group_name, url, num, epg_id, year, rating, stalker_cmd, extra)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        item.id || "", connectionId, type, item.name || "",
        item.logo || null, item.group || null, item.url || null,
        item.num || null, item.epgId || null, item.year || null,
        item.rating || null, item.stalkerCmd || null,
        item.extra ? JSON.stringify(item.extra) : null
      )
    );
  }

  // Update sync_meta
  stmts.push(
    db.prepare(
      `INSERT OR REPLACE INTO sync_meta (user_id, connection_id, data_type, last_synced, item_count)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(guestId, connectionId, type, Date.now(), items.length)
  );

  await db.batch(stmts);
  return jsonResponse({ ok: true, count: items.length });
}

// ── GET /api/catalog/content?connectionId=X&type=Y
export async function handleGetContent(request, env, url) {
  const { guestId, error } = authGuard(request);
  if (error) return error;

  const connectionId = url.searchParams.get("connectionId");
  const type = url.searchParams.get("type");
  if (!connectionId || !type) return errorResponse("connectionId and type required", 400);

  const { results } = await env.SV_DB.prepare(
    "SELECT * FROM content_items WHERE connection_id = ? AND type = ?"
  ).bind(connectionId, type).all();

  const items = results.map(r => ({
    id: r.id, name: r.name, logo: r.logo, group: r.group_name,
    url: r.url, num: r.num, epgId: r.epg_id, year: r.year,
    rating: r.rating, stalkerCmd: r.stalker_cmd,
    type: r.type,
    ...(r.extra ? JSON.parse(r.extra) : {}),
  }));

  return jsonResponse({ items });
}

// ── DELETE /api/catalog/content?connectionId=X&type=Y
export async function handleDeleteContent(request, env, url) {
  const { guestId, error } = authGuard(request);
  if (error) return error;

  const connectionId = url.searchParams.get("connectionId");
  const type = url.searchParams.get("type");
  if (!connectionId) return errorResponse("connectionId required", 400);

  if (type) {
    await env.SV_DB.prepare(
      "DELETE FROM content_items WHERE connection_id = ? AND type = ?"
    ).bind(connectionId, type).run();
  } else {
    await env.SV_DB.prepare(
      "DELETE FROM content_items WHERE connection_id = ?"
    ).bind(connectionId).run();
  }

  return jsonResponse({ ok: true });
}

// ── PUT /api/catalog/connections — save connection
export async function handlePutConnection(request, env) {
  const { guestId, error } = authGuard(request);
  if (error) return error;
  await ensureUser(env.SV_DB, guestId);

  const { id, type, label, config } = await request.json();
  if (!id || !type || !config) return errorResponse("id, type, config required", 400);

  await env.SV_DB.prepare(
    `INSERT OR REPLACE INTO connections (id, user_id, type, label, config)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(id, guestId, type, label || null, JSON.stringify(config)).run();

  return jsonResponse({ ok: true });
}

// ── GET /api/catalog/connections
export async function handleGetConnections(request, env) {
  const { guestId, error } = authGuard(request);
  if (error) return error;

  const { results } = await env.SV_DB.prepare(
    "SELECT * FROM connections WHERE user_id = ? ORDER BY created_at DESC"
  ).bind(guestId).all();

  return jsonResponse({
    connections: results.map(r => ({
      id: r.id, type: r.type, label: r.label,
      config: JSON.parse(r.config), created_at: r.created_at,
    })),
  });
}

// ── DELETE /api/catalog/connections?id=X
export async function handleDeleteConnection(request, env, url) {
  const { guestId, error } = authGuard(request);
  if (error) return error;

  const id = url.searchParams.get("id");
  if (!id) return errorResponse("id required", 400);

  await env.SV_DB.batch([
    env.SV_DB.prepare("DELETE FROM connections WHERE id = ? AND user_id = ?").bind(id, guestId),
    env.SV_DB.prepare("DELETE FROM content_items WHERE connection_id = ?").bind(id),
    env.SV_DB.prepare("DELETE FROM stalker_categories WHERE connection_id = ?").bind(id),
    env.SV_DB.prepare("DELETE FROM sync_meta WHERE connection_id = ? AND user_id = ?").bind(id, guestId),
  ]);

  return jsonResponse({ ok: true });
}

// ── PUT /api/catalog/categories — save stalker categories
export async function handlePutCategories(request, env) {
  const { guestId, error } = authGuard(request);
  if (error) return error;

  const { connectionId, section, categories } = await request.json();
  if (!connectionId || !section || !Array.isArray(categories)) {
    return errorResponse("connectionId, section, categories[] required", 400);
  }

  const db = env.SV_DB;
  const stmts = [
    db.prepare("DELETE FROM stalker_categories WHERE connection_id = ? AND section = ?")
      .bind(connectionId, section),
  ];

  for (const cat of categories) {
    stmts.push(
      db.prepare(
        "INSERT INTO stalker_categories (id, connection_id, section, title, count) VALUES (?, ?, ?, ?, ?)"
      ).bind(cat.id, connectionId, section, cat.title, cat.count || 0)
    );
  }

  await db.batch(stmts);
  return jsonResponse({ ok: true, count: categories.length });
}

// ── GET /api/catalog/categories?connectionId=X&section=Y
export async function handleGetCategories(request, env, url) {
  const { guestId, error } = authGuard(request);
  if (error) return error;

  const connectionId = url.searchParams.get("connectionId");
  const section = url.searchParams.get("section");
  if (!connectionId || !section) return errorResponse("connectionId and section required", 400);

  const { results } = await env.SV_DB.prepare(
    "SELECT * FROM stalker_categories WHERE connection_id = ? AND section = ?"
  ).bind(connectionId, section).all();

  return jsonResponse({
    categories: results.map(r => ({ id: r.id, title: r.title, count: r.count })),
  });
}

// ── GET /api/catalog/favorites
export async function handleGetFavorites(request, env, url) {
  const { guestId, error } = authGuard(request);
  if (error) return error;

  const profileId = url.searchParams.get("profileId") || "default";

  const { results } = await env.SV_DB.prepare(
    "SELECT * FROM favorites WHERE user_id = ? AND profile_id = ?"
  ).bind(guestId, profileId).all();

  // Rebuild {live:{}, vod:{}, series:{}} structure
  const favs = { live: {}, vod: {}, series: {} };
  for (const r of results) {
    const data = JSON.parse(r.item_data);
    if (!favs[r.item_type]) favs[r.item_type] = {};
    favs[r.item_type][r.item_id] = data;
  }

  return jsonResponse({ favorites: favs });
}

// ── PUT /api/catalog/favorites — save full favorites object
export async function handlePutFavorites(request, env) {
  const { guestId, error } = authGuard(request);
  if (error) return error;
  await ensureUser(env.SV_DB, guestId);

  const { profileId, favorites } = await request.json();
  if (!profileId || !favorites) return errorResponse("profileId and favorites required", 400);

  const db = env.SV_DB;
  const stmts = [
    db.prepare("DELETE FROM favorites WHERE user_id = ? AND profile_id = ?")
      .bind(guestId, profileId),
  ];

  for (const [itemType, items] of Object.entries(favorites)) {
    for (const [itemId, data] of Object.entries(items)) {
      stmts.push(
        db.prepare(
          `INSERT INTO favorites (user_id, profile_id, item_id, item_type, item_data)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(guestId, profileId, itemId, itemType, JSON.stringify(data))
      );
    }
  }

  await db.batch(stmts);
  return jsonResponse({ ok: true });
}

// ── GET /api/catalog/history
export async function handleGetHistory(request, env) {
  const { guestId, error } = authGuard(request);
  if (error) return error;

  const { results } = await env.SV_DB.prepare(
    "SELECT * FROM watch_history WHERE user_id = ? ORDER BY timestamp DESC LIMIT 60"
  ).bind(guestId).all();

  return jsonResponse({
    history: results.map(r => ({
      id: r.item_id, name: r.name, url: r.url, logo: r.logo,
      group: r.group_name, type: r.type,
      position: r.position, duration: r.duration, timestamp: r.timestamp,
    })),
  });
}

// ── PUT /api/catalog/history — save full history array
export async function handlePutHistory(request, env) {
  const { guestId, error } = authGuard(request);
  if (error) return error;
  await ensureUser(env.SV_DB, guestId);

  const { history } = await request.json();
  if (!Array.isArray(history)) return errorResponse("history[] required", 400);

  const db = env.SV_DB;
  const stmts = [
    db.prepare("DELETE FROM watch_history WHERE user_id = ?").bind(guestId),
  ];

  for (const h of history.slice(0, 60)) {
    stmts.push(
      db.prepare(
        `INSERT INTO watch_history (user_id, item_id, name, url, logo, group_name, type, position, duration, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        guestId, h.id || h.url || "", h.name || null, h.url || null,
        h.logo || null, h.group || null, h.type || "live",
        h.position || 0, h.duration || 0, h.timestamp || Date.now()
      )
    );
  }

  await db.batch(stmts);
  return jsonResponse({ ok: true });
}

// ── PATCH /api/catalog/history — update position for one item
export async function handlePatchHistory(request, env) {
  const { guestId, error } = authGuard(request);
  if (error) return error;

  const { itemId, position, duration } = await request.json();
  if (!itemId) return errorResponse("itemId required", 400);

  await env.SV_DB.prepare(
    "UPDATE watch_history SET position = ?, duration = ?, timestamp = ? WHERE user_id = ? AND item_id = ?"
  ).bind(position || 0, duration || 0, Date.now(), guestId, itemId).run();

  return jsonResponse({ ok: true });
}

// ── GET /api/catalog/preferences
export async function handleGetPreferences(request, env) {
  const { guestId, error } = authGuard(request);
  if (error) return error;

  const { results } = await env.SV_DB.prepare(
    "SELECT key, value FROM user_preferences WHERE user_id = ?"
  ).bind(guestId).all();

  const prefs = {};
  for (const r of results) {
    try { prefs[r.key] = JSON.parse(r.value); } catch { prefs[r.key] = r.value; }
  }

  return jsonResponse({ preferences: prefs });
}

// ── PUT /api/catalog/preferences — save preferences object
export async function handlePutPreferences(request, env) {
  const { guestId, error } = authGuard(request);
  if (error) return error;
  await ensureUser(env.SV_DB, guestId);

  const { preferences } = await request.json();
  if (!preferences || typeof preferences !== "object") {
    return errorResponse("preferences object required", 400);
  }

  const db = env.SV_DB;
  const stmts = [];
  for (const [key, value] of Object.entries(preferences)) {
    stmts.push(
      db.prepare(
        "INSERT OR REPLACE INTO user_preferences (user_id, key, value) VALUES (?, ?, ?)"
      ).bind(guestId, key, JSON.stringify(value))
    );
  }

  if (stmts.length) await db.batch(stmts);
  return jsonResponse({ ok: true });
}

// ── GET /api/catalog/sync-status?connectionId=X
export async function handleGetSyncStatus(request, env, url) {
  const { guestId, error } = authGuard(request);
  if (error) return error;

  const connectionId = url.searchParams.get("connectionId");

  let results;
  if (connectionId) {
    ({ results } = await env.SV_DB.prepare(
      "SELECT * FROM sync_meta WHERE user_id = ? AND connection_id = ?"
    ).bind(guestId, connectionId).all());
  } else {
    ({ results } = await env.SV_DB.prepare(
      "SELECT * FROM sync_meta WHERE user_id = ?"
    ).bind(guestId).all());
  }

  return jsonResponse({
    sync: results.map(r => ({
      connectionId: r.connection_id, dataType: r.data_type,
      lastSynced: r.last_synced, itemCount: r.item_count,
    })),
  });
}
