const GA_ID = import.meta.env.VITE_GA_MEASUREMENT_ID;
const CONSENT_KEY = "sv-analytics-consent";
const CONSENT_EVENT = "sv-analytics-consent-change";
const VALID_CONSENT = new Set(["granted", "denied"]);
const SENSITIVE_KEY = /(^|_)(email|username|user_id|password|token|url|uri|host|server|portal|mac|device|title|name|query|search_term|category|content_id|item_id|connection_id)(_|$)/i;
const SAFE_STRING = /^[a-z0-9 _.:/-]{0,80}$/i;

let configured = false;
let scriptRequested = false;

function validMeasurementId() {
  return Boolean(GA_ID && !GA_ID.startsWith("G-XXX"));
}

export function isAnalyticsAvailable() {
  return validMeasurementId();
}

function ensureGtag() {
  globalThis.dataLayer = globalThis.dataLayer || [];
  if (typeof globalThis.gtag !== "function") {
    globalThis.gtag = function gtag() {
      globalThis.dataLayer.push(arguments);
    };
  }
  return globalThis.gtag;
}

function consentPayload(value) {
  const state = value === "granted" ? "granted" : "denied";
  return {
    analytics_storage: state,
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
  };
}

function configureAnalytics() {
  if (configured || !validMeasurementId()) return;
  configured = true;
  const gtag = ensureGtag();
  const safePagePath = location.pathname === "/content" ? "/content" : "/app";
  gtag("js", new Date());
  gtag("config", GA_ID, {
    send_page_view: false,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
    page_location: `${location.origin}${safePagePath}`,
    page_title: "Portal Heaven",
  });
}

function requestGoogleTag() {
  if (scriptRequested || !validMeasurementId() || typeof document === "undefined") return;
  scriptRequested = true;
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_ID)}`;
  script.dataset.portalHeavenAnalytics = "true";
  script.onload = configureAnalytics;
  script.onerror = () => { scriptRequested = false; };
  document.head.appendChild(script);
  // Events may safely queue while gtag.js downloads.
  configureAnalytics();
}

export function getAnalyticsConsent() {
  try {
    const value = localStorage.getItem(CONSENT_KEY);
    return VALID_CONSENT.has(value) ? value : null;
  } catch {
    return null;
  }
}

export function setAnalyticsConsent(value) {
  const normalized = value === "granted" ? "granted" : "denied";
  try { localStorage.setItem(CONSENT_KEY, normalized); } catch { /* Storage may be unavailable. */ }
  const gtag = ensureGtag();
  gtag("consent", "update", consentPayload(normalized));
  if (normalized === "granted") requestGoogleTag();
  globalThis.dispatchEvent?.(new CustomEvent(CONSENT_EVENT, { detail: normalized }));
  return normalized;
}

export function initializeAnalytics() {
  if (!validMeasurementId()) return false;
  const consent = getAnalyticsConsent();
  const gtag = ensureGtag();
  gtag("consent", "default", {
    ...consentPayload(consent),
    wait_for_update: 500,
  });
  if (consent === "granted") {
    gtag("consent", "update", consentPayload("granted"));
    requestGoogleTag();
  }
  return true;
}

export function subscribeAnalyticsConsent(listener) {
  const handler = event => listener(event.detail);
  globalThis.addEventListener?.(CONSENT_EVENT, handler);
  return () => globalThis.removeEventListener?.(CONSENT_EVENT, handler);
}

export function categorizeAnalyticsError(error) {
  const text = String(error?.code || error?.message || error || "").toLowerCase();
  const status = Number(text.match(/\b(401|403|404|408|429|456|459|462|5\d\d)\b/)?.[1] || 0);
  if (/cors|orb|mixed content/.test(text)) return "browser_policy";
  if (status === 401 || /unauthori[sz]ed/.test(text)) return "unauthorized";
  if (status === 403 || /forbidden|blocked/.test(text)) return "blocked";
  if (status === 404) return "not_found";
  if (status === 408 || /timed? ?out|timeout/.test(text)) return "timeout";
  if (status === 429 || /rate.?limit|throttl/.test(text)) return "rate_limited";
  if (status === 456) return "provider_rejected";
  if (status === 459 || status === 462 || /expired/.test(text)) return "expired";
  if (status >= 500 || /bad gateway|upstream|server failure|unavailable/.test(text)) return "provider_unavailable";
  if (/credential|authentication failed|invalid account/.test(text)) return "invalid_credentials";
  if (/network|fetch|connection|unreachable/.test(text)) return "network";
  if (/validation|required|invalid/.test(text)) return "validation_failed";
  return "unknown";
}

export function sanitizeAnalyticsPayload(payload = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(payload || {})) {
    if (!/^[a-z][a-z0-9_]{0,39}$/i.test(key)) continue;
    if (value == null) continue;
    if (key === "error_code") {
      safe.failure_category = categorizeAnalyticsError(value);
      continue;
    }
    if (SENSITIVE_KEY.test(key)) continue;
    if (typeof value === "boolean") {
      safe[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      safe[key] = Math.round(value);
    } else if (typeof value === "string" && SAFE_STRING.test(value) && !/@|https?:|[?&=]/i.test(value)) {
      safe[key] = value.slice(0, 80);
    }
  }
  return safe;
}

export function trackAnalytics(eventName, payload = {}) {
  if (!validMeasurementId() || getAnalyticsConsent() !== "granted" || typeof globalThis.gtag !== "function") return false;
  const safeEvent = String(eventName || "").trim();
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(safeEvent)) return false;
  globalThis.gtag("event", safeEvent, sanitizeAnalyticsPayload(payload));
  return true;
}

export function trackAnalyticsScreen(screen, payload = {}) {
  return trackAnalytics("screen_view", {
    screen: String(screen || "unknown").toLowerCase(),
    ...payload,
  });
}

export function analyticsPlaybackRoute(item) {
  if (item?._stalkerRelayActive || /^\/(?:stream|stalker\/play)(?:\?|$)/.test(String(item?.url || ""))) return "relay";
  return "direct";
}

export const ANALYTICS_CONSENT_KEY = CONSENT_KEY;
