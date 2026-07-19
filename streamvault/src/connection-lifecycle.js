const INVALID_STATUSES = new Set(["disabled", "expired", "blocked", "suspended", "unregistered", "0"]);

function asTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return null;
    return number < 1e12 ? number * 1000 : number;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeConnection(raw) {
  if (!raw || typeof raw !== "object" || !raw.id) return null;
  const config = raw.config && typeof raw.config === "object" ? raw.config : raw;
  const type = raw.type || config.type;
  if (!type) return null;
  return { ...raw, id: String(raw.id), type, label: raw.label || `${type} connection`, config };
}

export function normalizeConnections(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.map(normalizeConnection).filter((connection) => {
    if (!connection || seen.has(connection.id)) return false;
    seen.add(connection.id);
    return true;
  });
}

export function mergeConnectionSnapshots(...snapshots) {
  const merged = new Map();
  for (const snapshot of snapshots) {
    for (const connection of normalizeConnections(snapshot)) merged.set(connection.id, connection);
  }
  return [...merged.values()];
}

export function getConnectionLifecycle(connection, now = Date.now()) {
  const config = connection?.config || connection || {};
  const accountInfo = config.accountInfo || config.user_info || config.info || {};
  const status = String(accountInfo.status ?? config.status ?? "").trim().toLowerCase();
  const expiresAt = [accountInfo.expiry, accountInfo.exp_date, accountInfo.expiresAt, config.expiry, config.exp_date, config.expiresAt, config.expires_at]
    .map(asTimestamp).find(Boolean) || null;
  const expired = status === "expired" || (expiresAt !== null && expiresAt <= now);
  const invalid = INVALID_STATUSES.has(status) || expired;
  return { valid: !invalid, expired, status: status || (expired ? "expired" : "unknown"), expiresAt };
}

export function lifecycleFailureMessage(connection, now = Date.now()) {
  const lifecycle = getConnectionLifecycle(connection, now);
  if (lifecycle.expired) {
    return lifecycle.expiresAt
      ? `Account expired on ${new Date(lifecycle.expiresAt).toLocaleDateString()}. Contact your provider.`
      : "Account expired. Contact your provider.";
  }
  if (lifecycle.status === "disabled") return "Connection is disabled. Contact your provider.";
  if (lifecycle.status === "blocked") return "Account is blocked. Contact your provider.";
  if (lifecycle.status === "suspended") return "Account is suspended. Contact your provider.";
  if (lifecycle.status === "unregistered") return "Connection is not registered with the provider.";
  return null;
}
