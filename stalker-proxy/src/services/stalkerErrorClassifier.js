/**
 * Map provider-thrown errors to consistent HTTP status codes and error codes.
 *
 * Used by every Stalker route to ensure the frontend sees predictable
 * error classifications regardless of which endpoint the error came from.
 */

/**
 * @param {Error|object} error
 * @returns {{ status: number, code: string }}
 */
function classifyProviderError(error) {
  const msg = (error?.message || "").toLowerCase();
  const explicitCode = String(error?.code || "").toUpperCase();
  const explicitStatus = Number(error?.status || error?.statusCode || 0);

  if (explicitCode === "URL_NOT_ALLOWED") {
    return { status: 403, code: "url_not_allowed" };
  }
  if (explicitCode === "CATALOG_TOO_LARGE") {
    return { status: 502, code: "catalog_too_large" };
  }
  if (explicitCode === "PROVIDER_COOLDOWN") {
    return { status: 429, code: "provider_cooldown" };
  }
  if ([401, 403].includes(explicitStatus)
      || /authorization|auth failed|device not found|access denied|forbidden/i.test(msg)) {
    return { status: 403, code: "authorization_failure" };
  }
  if (explicitStatus === 429 || explicitCode === "RATE_LIMITED"
      || /rate limit|too many request/i.test(msg)) {
    return { status: 429, code: "rate_limited" };
  }
  if (explicitStatus === 410 || /expired|invalid token/i.test(msg)) {
    return { status: 410, code: "expired" };
  }
  if ([408, 504].includes(explicitStatus)
      || /ABORT|TIMEOUT|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND/.test(explicitCode)
      || /timeout|timed ?out|econn?reset|econn?refused|etimedout|enotfound/i.test(msg)) {
    return { status: 504, code: "provider_timeout" };
  }
  if (explicitStatus === 404 || /content not found|no (?:stream|url)|no such|not found|cannot find/i.test(msg)) {
    return { status: 404, code: "content_not_found" };
  }

  return { status: 502, code: "provider_failure" };
}

module.exports = { classifyProviderError };
