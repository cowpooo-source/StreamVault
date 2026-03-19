// CORS headers added to every response

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range, X-Guest-Id",
  "Access-Control-Max-Age": "86400",
};

export function corsHeaders(extra = {}) {
  return { ...CORS_HEADERS, ...extra };
}

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

export function errorResponse(message, status = 502) {
  return jsonResponse({ error: message }, status);
}

export function handleOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
