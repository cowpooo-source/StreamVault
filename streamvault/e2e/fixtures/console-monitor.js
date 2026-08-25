/**
 * Browser error monitor for Playwright tests.
 *
 * Collects page errors, console.error calls, failed requests, and
 * same-origin responses with status >= 400 from application routes.
 * After each test the collected errors are checked against an allowlist;
 * unexpected errors cause the test to fail.
 */

const TRACKED_PREFIXES = ["/api/", "/stalker/", "/proxy", "/stream", "/img"];

export class ConsoleMonitor {
  constructor() {
    this.pageErrors = [];
    this.consoleErrors = [];
    this.failedRequests = [];
    this.badResponses = [];
    this.abortedProviderRequests = 0;
    this._handlers = [];
  }

  /**
   * Attach all listeners to a Playwright Page.
   * Call this once per page, before navigation.
   */
  attach(page) {
    const onPageError = (err) => {
      this.pageErrors.push(err.message || String(err));
    };
    const onConsole = (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        const sourceUrl = msg.location().url || "";
        // Ignore Cloudflare Turnstile CDN — third-party, expected to fail in test environments.
        if (text.includes("challenges.cloudflare.com") || sourceUrl.includes("challenges.cloudflare.com")) return;
        // The underlying aborted proxy request is tracked separately. During
        // a document transition this duplicate message is expected.
        if (text.startsWith("EPG error: TypeError: Failed to fetch")) return;
        // Ignore the browser's generic HTTP error echo — we track the same
        // event with full URL context in the response listener.
        if (text.startsWith("Failed to load resource: the server responded with a status of")) return;
        // Chromium may reject intentionally minimal media fixture bodies after
        // the engine-selection assertion has completed. Keep this exception
        // scoped to controlled E2E hosts; real app/provider failures remain fatal.
        if (text === "Failed to load resource: net::ERR_FAILED"
          && /^http:\/\/(?:media|images)\.test\//.test(sourceUrl)) return;
        this.consoleErrors.push(text);
      }
    };
    const onRequestFailed = (request) => {
      const url = request.url();
      if (url.includes("/favicon")) return;
      if (url.includes("challenges.cloudflare.com")) return;
      if (request.failure()?.errorText === "net::ERR_ABORTED") {
        try {
          if (["/api/", "/proxy", "/stream", "/stalker"].some((path) => new URL(url).pathname.startsWith(path))) {
            this.abortedProviderRequests += 1;
          }
        } catch { /* malformed URLs are reported normally below */ }
        return;
      }
      this.failedRequests.push({
        url: sanitizeUrl(url),
        method: request.method(),
        failure: request.failure()?.errorText || "unknown",
      });
    };
    const onResponse = (response) => {
      const status = response.status();
      if (status < 400) return;
      const url = new URL(response.url());
      // Only track same-origin application responses.
      if (url.origin !== page.url().split("/").slice(0, 3).join("/")) return;
      if (!TRACKED_PREFIXES.some((p) => url.pathname.startsWith(p))) return;
      // 401 from /api/auth/me is expected when testing logged-out flows.
      if (url.pathname === "/api/auth/me" && status === 401) return;
      // 401 from /api/auth/login is expected in invalid-login tests.
      if (url.pathname === "/api/auth/login" && status === 401) return;
      this.badResponses.push({
        url: sanitizeUrl(response.url()),
        method: response.request().method(),
        status,
      });
    };

    page.on("pageerror", onPageError);
    page.on("console", onConsole);
    page.on("requestfailed", onRequestFailed);
    page.on("response", onResponse);

    this._handlers.push(
      { page, event: "pageerror", handler: onPageError },
      { page, event: "console", handler: onConsole },
      { page, event: "requestfailed", handler: onRequestFailed },
      { page, event: "response", handler: onResponse },
    );
  }

  /**
   * Detach all listeners.  Safe to call multiple times.
   */
  detach() {
    for (const { page, event, handler } of this._handlers) {
      page.removeListener(event, handler);
    }
    this._handlers = [];
  }

  snapshot() {
    const consoleErrors = this.abortedProviderRequests > 0
      ? this.consoleErrors.filter((message) => !message.includes("TypeError: Failed to fetch"))
      : this.consoleErrors;
    return {
      pageErrors: [...this.pageErrors],
      consoleErrors: [...consoleErrors],
      failedRequests: [...this.failedRequests],
      badResponses: [...this.badResponses],
    };
  }

  reset() {
    this.pageErrors.length = 0;
    this.consoleErrors.length = 0;
    this.failedRequests.length = 0;
    this.badResponses.length = 0;
    this.abortedProviderRequests = 0;
  }
}

/**
 * Strip credentials from a URL for safe reporting.
 *
 * Redacts:
 * - Query-string params: username, password, mac, token, pass, user, play_token
 * - Xtream-style path segments: /live/user/pass/..., /movie/user/pass/...
 * - Encoded proxy target URLs: /proxy?url=<encoded-xtream-url>
 */
export function sanitizeUrl(raw) {
  try {
    const url = new URL(raw);

    // Redact query-string credentials.
    for (const key of ["username", "password", "mac", "token", "play_token", "pass", "user"]) {
      if (url.searchParams.has(key)) url.searchParams.set(key, "***");
    }

    // Redact credentials inside encoded /proxy?url=... values.
    const proxyTarget = url.searchParams.get("url");
    if (proxyTarget) {
      url.searchParams.set("url", sanitizeUrl(proxyTarget));
    }

    // Redact Xtream-style path credentials: /live/<user>/<pass>/<id>.ts
    const segments = url.pathname.split("/");
    const credPrefixes = ["live", "movie", "series", "timeshift"];
    for (let i = 0; i < segments.length - 2; i++) {
      if (credPrefixes.includes(segments[i])) {
        // segments[i+1] is user, segments[i+2] is pass
        if (segments[i + 1]) segments[i + 1] = "***";
        if (segments[i + 2]) segments[i + 2] = "***";
        break;
      }
    }
    url.pathname = segments.join("/");

    return url.toString();
  } catch {
    return raw;
  }
}
