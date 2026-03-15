export async function onRequestGet() {
  return Response.json({ status: "ok", runtime: "cloudflare-pages" });
}
