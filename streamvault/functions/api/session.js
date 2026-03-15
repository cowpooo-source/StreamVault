// Pages Function: /api/session
// Binds to KV namespace "SV_SESSIONS"

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const guestId = url.searchParams.get("id");
  if (!guestId || guestId.length < 8) {
    return Response.json({ error: "Valid guest id required" }, { status: 400 });
  }

  const data = await context.env.SV_SESSIONS.get(`guest:${guestId}`, "json");
  if (!data) {
    return Response.json({ data: null });
  }
  return Response.json({ data });
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const { guestId, data } = body;
    if (!guestId || guestId.length < 8) {
      return Response.json({ error: "Valid guest id required" }, { status: 400 });
    }
    if (!data || typeof data !== "object") {
      return Response.json({ error: "data object required" }, { status: 400 });
    }

    // Store with 90-day expiration (seconds)
    await context.env.SV_SESSIONS.put(
      `guest:${guestId}`,
      JSON.stringify(data),
      { expirationTtl: 90 * 24 * 60 * 60 }
    );

    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
