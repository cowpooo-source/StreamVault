import React, { useEffect, useState } from "react";
import {
  getAnalyticsConsent,
  isAnalyticsAvailable,
  setAnalyticsConsent,
  subscribeAnalyticsConsent,
} from "../analytics.js";

export default function AnalyticsConsent() {
  const [consent, setConsent] = useState(getAnalyticsConsent);

  useEffect(() => subscribeAnalyticsConsent(setConsent), []);

  if (!isAnalyticsAvailable() || consent !== null) return null;

  return (
    <aside
      aria-label="Analytics privacy choices"
      style={{
        position: "fixed",
        zIndex: 100000,
        left: "max(1rem, env(safe-area-inset-left))",
        right: "max(1rem, env(safe-area-inset-right))",
        bottom: "max(1rem, env(safe-area-inset-bottom))",
        maxWidth: 620,
        margin: "0 auto",
        padding: "1rem",
        borderRadius: 12,
        border: "1px solid var(--b2, rgba(255,255,255,.16))",
        background: "var(--s1, #111522)",
        color: "var(--t1, #f5f7ff)",
        boxShadow: "0 12px 36px rgba(0,0,0,.45)",
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: ".35rem" }}>Help improve Portal Heaven</div>
      <div style={{ color: "var(--t2, #aab1c5)", fontSize: ".82rem", lineHeight: 1.5 }}>
        Optional analytics help us understand setup failures and playback reliability. We never send provider URLs,
        credentials, content titles, searches, or account details to Google.
      </div>
      <div style={{ display: "flex", gap: ".55rem", justifyContent: "flex-end", marginTop: ".85rem", flexWrap: "wrap" }}>
        <button type="button" className="btn-sm" onClick={() => setAnalyticsConsent("denied")}>
          No thanks
        </button>
        <button type="button" className="btn-primary" onClick={() => setAnalyticsConsent("granted")}>
          Allow analytics
        </button>
      </div>
    </aside>
  );
}
