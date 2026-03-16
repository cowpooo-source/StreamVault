// Worker entrypoint — handles /api/* and /stream routes, passes everything else to static assets

import { onRequestGet as sessionGet, onRequestPost as sessionPost } from './api/session.js';
import { onRequestGet as healthGet } from './api/health.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Route /api/* to handlers
    if (url.pathname === '/api/health' && request.method === 'GET') {
      return healthGet({ request, env, ctx });
    }
    if (url.pathname === '/api/session') {
      if (request.method === 'GET') return sessionGet({ request, env, ctx });
      if (request.method === 'POST') return sessionPost({ request, env, ctx });
      return new Response('Method not allowed', { status: 405 });
    }

    // Stream proxy — proxies HLS segments from HTTP IPTV servers over HTTPS
    if (url.pathname === '/stream' && request.method === 'GET') {
      const target = url.searchParams.get('url');
      if (!target) return new Response('url parameter required', { status: 400 });
      try {
        const upstream = await fetch(target, {
          headers: { 'User-Agent': 'StreamVault/1.0' },
          redirect: 'follow',
        });
        const headers = new Headers();
        headers.set('Access-Control-Allow-Origin', '*');
        headers.set('Access-Control-Allow-Methods', 'GET');
        const ct = upstream.headers.get('content-type');
        if (ct) headers.set('Content-Type', ct);
        // For .m3u8 manifests, rewrite HTTP segment URLs to go through /stream
        if (ct?.includes('mpegurl') || target.includes('.m3u8')) {
          let body = await upstream.text();
          // Rewrite absolute HTTP URLs in the manifest
          body = body.replace(/^(http:\/\/[^\s]+)/gm, (match) =>
            `${url.origin}/stream?url=${encodeURIComponent(match)}`
          );
          headers.set('Content-Type', 'application/vnd.apple.mpegurl');
          return new Response(body, { status: upstream.status, headers });
        }
        // For segments (.ts), stream the body directly
        return new Response(upstream.body, { status: upstream.status, headers });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Everything else: pass to static assets
    return env.ASSETS.fetch(request);
  }
};
