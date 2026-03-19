// Extract guest ID from request, auto-create user row if needed

export function getGuestId(request) {
  return request.headers.get("X-Guest-Id") || null;
}

export async function ensureUser(db, guestId) {
  await db.prepare(
    "INSERT OR IGNORE INTO users (id) VALUES (?)"
  ).bind(guestId).run();
}
