const STATUS_RE = /\b(400|401|402|403|404|405|406|408|409|410|422|429|451|456|459|462|500|501|502|503|504)\b/;

export const IPTV_ERROR_CATEGORIES = Object.freeze([
  "invalid_credentials",
  "validation_failed",
  "unauthorized",
  "blocked",
  "not_found",
  "expired",
  "provider_rejected",
  "rate_limited",
  "timeout",
  "provider_unavailable",
  "browser_policy",
  "unsupported_format",
  "network",
  "unknown",
]);

const TERMINAL_STATUSES = new Set([400, 401, 402, 403, 404, 405, 406, 410, 422, 451, 456, 459, 462]);
const NO_AUTOMATIC_RETRY_HTTP_STATUS = new Set([
  400, 401, 402, 403, 404, 405, 406, 410, 423, 429, 451, 456, 459, 462,
]);

function errorText(error) {
  if (typeof error === "string") return error;
  return String(error?.message || error?.error || error?.code || error || "");
}

function statusFrom(error, text) {
  const status = Number(error?.status || error?.statusCode || 0);
  if (Number.isInteger(status) && status > 0) return status;
  return Number(text.match(STATUS_RE)?.[1] || 0);
}

export function categorizeIptvError(error) {
  const text = errorText(error).toLowerCase();
  const status = statusFrom(error, text);
  if (/cors|orb|mixed content|cross-origin|content security|access-control-allow-origin/.test(text)) return "browser_policy";
  if (/formatunsupported|unsupported media|unsupported codec|source not supported|decode error|not supported/.test(text)) return "unsupported_format";
  if (status === 401 || /unauthori[sz]ed|authentication required/.test(text)) return "unauthorized";
  if (status === 403 || /forbidden|blocked|access denied|device not found/.test(text)) return "blocked";
  if (status === 404 || /not found|no stream|no url/.test(text)) return "not_found";
  if (status === 408 || /timed? ?out|timeout/.test(text)) return "timeout";
  if (status === 429 || /rate.?limit|throttl|too many request/.test(text)) return "rate_limited";
  if (status === 456 || /provider rejected|account blocked|ip blocked/.test(text)) return "provider_rejected";
  if (status === 410 || status === 459 || status === 462 || /expired|invalid token|token expired/.test(text)) return "expired";
  if (status >= 500 || /bad gateway|upstream|server failure|server unavailable|relay failed/.test(text)) return "provider_unavailable";
  if (/credential|invalid username|invalid password|authentication failed|invalid account/.test(text)) return "invalid_credentials";
  if (/validation|required|malformed|invalid url|invalid connection/.test(text)) return "validation_failed";
  if (/network|fetch|connection|unreachable|connection reset|connection refused|dns|chunked|content.?length/.test(text)) return "network";
  return "unknown";
}

export function isRetryableIptvError(error, { allowRateLimit = false } = {}) {
  const normalized = normalizeIptvError(error);
  if (normalized.category === "rate_limited") return allowRateLimit;
  return !normalized.terminal && ["timeout", "provider_unavailable", "network"].includes(normalized.category);
}

export function normalizeIptvError(error, options = {}) {
  const text = errorText(error);
  const status = statusFrom(error, text);
  const category = options.category || categorizeIptvError(error);
  const terminal = options.terminal ?? (TERMINAL_STATUSES.has(status) || [
    "invalid_credentials", "validation_failed", "unauthorized", "blocked", "not_found",
    "browser_policy", "unsupported_format", "expired", "provider_rejected",
  ].includes(category));
  return {
    category: IPTV_ERROR_CATEGORIES.includes(category) ? category : "unknown",
    code: error?.code || (status ? `HTTP_${status}` : category),
    status: status || null,
    terminal,
    retryable: !terminal && ["timeout", "provider_unavailable", "network"].includes(category),
    message: text || "IPTV request failed",
  };
}

export function createIptvError(error, options = {}) {
  const normalized = normalizeIptvError(error, options);
  const wrapped = new Error(normalized.message);
  Object.assign(wrapped, normalized);
  wrapped.cause = error;
  return wrapped;
}

export function iptvErrorMessage(error) {
  const normalized = normalizeIptvError(error);
  const statusSuffix = normalized.status ? ` (${normalized.status})` : "";
  const messages = {
    invalid_credentials: "The provider username or password is invalid.",
    validation_failed: "The connection details are incomplete or invalid.",
    unauthorized: "The provider rejected this request. The account or session may no longer be valid.",
    blocked: "The provider blocked this request or device.",
    not_found: "The channel or video is no longer available.",
    expired: "The provider link or session expired. Try loading it again for a fresh link.",
    provider_rejected: "The provider rejected this stream. The account, IP, or concurrent-stream limit may be involved.",
    rate_limited: "The provider is rate limiting requests. Wait briefly before trying again.",
    timeout: "The provider did not respond in time.",
    provider_unavailable: "The provider or upstream server is temporarily unavailable.",
    browser_policy: "The browser blocked this stream because of CORS or another security policy.",
    unsupported_format: "This browser does not support the stream format or codec.",
    network: "The network connection to the provider was interrupted.",
    unknown: "The IPTV request could not be completed.",
  };
  return `${messages[normalized.category]}${statusSuffix}`;
}

export function shouldStopAutomaticRecovery(status) {
  const code = Number(status);
  return Number.isInteger(code) && NO_AUTOMATIC_RETRY_HTTP_STATUS.has(code);
}

export function playbackHttpError(status) {
  const code = Number(status);
  const normalized = normalizeIptvError({ status: code });
  const titles = {
    not_found: `Stream Not Found (${code})`,
    unauthorized: `Access Denied (${code})`,
    blocked: `Access Denied (${code})`,
    rate_limited: `Rate Limited (${code})`,
    provider_rejected: `Account Blocked (${code})`,
    expired: `Token Expired (${code})`,
  };
  return {
    icon: "!",
    title: titles[normalized.category] || `Stream Rejected (${code})`,
    body: iptvErrorMessage(normalized),
  };
}
