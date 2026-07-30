import React from "react";

const CONN_ICONS = { xtream: "📡", stalker: "📺", m3u: "📋", hls: "🔗" };

/**
 * ConnectionList - Saved connections list (no diagnostics)
 * @param {{ connections: array, activeConnId: string|null, onReconnect: function, onEdit: function, onRemoveConn: function }} props
 */
export function ConnectionList({ connections, onReconnect, onEdit, onRemoveConn }) {
  if (!connections || connections.length === 0) return null;

  return (
    <>
      <div style={{ marginBottom: "1.2rem" }}>
        <div className="fl" style={{ marginBottom: ".5rem" }}>Saved Connections</div>
        <div className="saved-conns">
          {connections.map(c => (
            <div key={c.id} className="saved-conn" style={{ borderLeft: `3px solid ${c.color || "var(--b2)"}`, flexDirection: "column", alignItems: "stretch" }}
              onClick={() => onReconnect && onReconnect(c.id)}
              onMouseEnter={e => e.currentTarget.style.borderColor = "var(--accent)"}
              onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--b2)"; e.currentTarget.style.borderLeftColor = c.color || "var(--b2)"; }}>
              <div style={{ display: "flex", alignItems: "center", gap: ".6rem" }}>
                <span style={{ fontSize: "1.1rem" }}>{CONN_ICONS[c.type] || "📡"}</span>
                <div style={{ flex: 1, overflow: "hidden" }}>
                  <div style={{ fontSize: ".82rem", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.label}</div>
                  <div style={{ fontSize: ".62rem", color: "var(--t3)", textTransform: "capitalize" }}>{c.type}</div>
                </div>
                <button onClick={e => { e.stopPropagation(); onEdit && onEdit(c); }}
                  style={{ background: "none", border: "none", color: "var(--t2)", cursor: "pointer", fontSize: ".85rem", padding: "2px 6px",
                    borderRadius: "4px", lineHeight: 1, flexShrink: 0 }}
                  title="Edit connection">✎</button>
                <button onClick={e => { e.stopPropagation(); if (confirm(`Delete "${c.label}"?`)) onRemoveConn?.(c.id); }}
                  style={{ background: "none", border: "none", color: "var(--t3)", cursor: "pointer", fontSize: ".85rem", padding: "2px 6px",
                    borderRadius: "4px", lineHeight: 1, flexShrink: 0 }}
                  onMouseEnter={e => e.currentTarget.style.color = "#e74c3c"}
                  onMouseLeave={e => e.currentTarget.style.color = "var(--t3)"}
                  title="Delete connection">✕</button>
              </div>
            </div>
          ))}
        </div>
        <div style={{ borderBottom: "1px solid var(--b2)", margin: "1rem 0 .2rem", position: "relative" }}>
          <span style={{
            position: "absolute", left: "50%", transform: "translate(-50%,-50%)", background: "var(--s1)",
            padding: "0 .6rem", fontSize: ".65rem", color: "var(--t3)", textTransform: "uppercase", letterSpacing: ".08em", fontWeight: 600
          }}>
            or add new
          </span>
        </div>
      </div>
    </>
  );
}
