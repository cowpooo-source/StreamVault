function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host.startsWith("fe80") || host.startsWith("fc00") || host.startsWith("fd")) return true;

  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return false;
  if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  return false;
}

function parseAllowedUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (isPrivateHost(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

export async function onRequestGet({ request }) {
  const requestUrl = new URL(request.url);
  const adUrl = parseAllowedUrl(requestUrl.searchParams.get("url"));
  if (!adUrl) return Response.json({ error: "URL not allowed" }, { status: 403 });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const upstream = await fetch(adUrl.toString(), {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "Accept": "application/xml,text/xml,*/*;q=0.8",
        "User-Agent": request.headers.get("user-agent") || "StreamVault/1.0",
      },
    });
    if (!upstream.ok) {
      return Response.json({ error: "VAST request failed" }, { status: upstream.status });
    }

    const contentLength = Number(upstream.headers.get("content-length") || 0);
    if (contentLength > 1024 * 1024) {
      return Response.json({ error: "VAST response too large" }, { status: 413 });
    }

    const xml = await upstream.text();
    if (xml.length > 1024 * 1024) {
      return Response.json({ error: "VAST response too large" }, { status: 413 });
    }

    return new Response(xml, {
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "application/xml; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return Response.json({ error: "VAST request failed" }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}
