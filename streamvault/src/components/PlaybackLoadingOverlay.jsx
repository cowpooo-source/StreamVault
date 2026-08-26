import React, { useEffect, useState } from "react";

export default function PlaybackLoadingOverlay({
  testId = "playback-loading",
  message = "Connecting to stream...",
  detail = "Waiting for the provider response",
  fullScreen = true,
  onCancel,
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div
      data-testid={testId}
      role="status"
      aria-live="polite"
      style={{
        position: fullScreen ? "fixed" : "absolute",
        inset: 0,
        zIndex: fullScreen ? 10000 : 3,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1.5rem",
        background: "rgba(0, 0, 0, .82)",
        color: "var(--t1, #fff)",
        textAlign: "center",
      }}
    >
      <div style={{ maxWidth: 360 }}>
        <div className="spinner" aria-hidden="true" style={{ margin: "0 auto 1rem" }} />
        <div style={{ fontSize: ".95rem", fontWeight: 600 }}>{message}</div>
        <div style={{ color: "var(--t2, #aab)", fontSize: ".78rem", lineHeight: 1.5, marginTop: ".45rem" }}>
          {detail}
          {elapsed >= 5 ? ` (${elapsed}s)` : ""}
        </div>
        {onCancel && (
          <button
            type="button"
            className="btn-secondary"
            style={{ marginTop: "1rem" }}
            onClick={onCancel}
          >
            Cancel loading
          </button>
        )}
      </div>
    </div>
  );
}
