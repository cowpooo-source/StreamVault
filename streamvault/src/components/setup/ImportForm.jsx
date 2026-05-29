import React, { useState } from "react";
import { detectFromText } from "./setup-utils.js";

/**
 * ImportForm - Raw text import with auto-detection of connection types
 * @param {{ rawText: string, setRawText: function, detected: array, selected: Set, setSelected: function, onFileImport: function, onImportMultiple: function, onFillSingle: function }} props
 */
export function ImportForm({ rawText, setRawText, detected, selected, setSelected, onFileImport, onImportMultiple, onFillSingle }) {

  const handleTextChange = (e) => {
    const text = e.target.value;
    setRawText(text);
    const d = detectFromText(text);
    // Notify parent to update detected state
    if (onFillSingle && d.length === 1) {
      // Single detection: pass to parent for click-to-fill
      onFillSingle(d[0], true);
    }
  };

  const handleSelectAll = (checked) => {
    if (checked) {
      setSelected(new Set(detected.map((_, i) => i)));
    } else {
      setSelected(new Set());
    }
  };

  const handleDetectedClick = (d, i) => {
    if (detected.length > 1) {
      setSelected(prev => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; });
    } else {
      if (onFillSingle) onFillSingle(d, true);
    }
  };

  return (
    <div>
      <div className="fg">
        <label className="fl">Paste Raw</label>
        <textarea
          className="fi"
          style={{ minHeight: "120px", resize: "vertical", fontFamily: "monospace", fontSize: ".75rem" }}
          placeholder={"Paste any text containing:\n• Stalker portal URLs + MAC addresses\n• Xtream Codes URLs with username/password\n• M3U/M3U8 playlist URLs\n\nAuto-detects all connection types."}
          value={rawText}
          onChange={handleTextChange}
        />
      </div>

      <div style={{ margin: "1rem 0", display: "flex", alignItems: "center", gap: ".8rem" }}>
        <div style={{ height: "1px", flex: 1, background: "var(--b2)" }}></div>
        <div style={{ fontSize: ".65rem", color: "var(--t3)", textTransform: "uppercase", fontWeight: 600 }}>OR</div>
        <div style={{ height: "1px", flex: 1, background: "var(--b2)" }}></div>
      </div>

      <div className="fg">
        <label className="fl">Import from Backup File</label>
        <div style={{ display: "flex", gap: ".5rem", marginTop: ".4rem" }}>
          <input type="file" accept=".json" onChange={onFileImport}
            style={{ fontSize: ".8rem", color: "var(--t2)", flex: 1 }} />
        </div>
        <div className="fhint">Select a .json file exported from Portal Heaven Settings.</div>
      </div>

      {detected && detected.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: ".4rem", marginBottom: "1rem" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div className="fl">Detected ({detected.length})</div>
            {detected.length > 1 && (
              <label style={{ fontSize: ".65rem", color: "var(--t3)", cursor: "pointer", display: "flex", alignItems: "center", gap: ".3rem" }}>
                <input
                  type="checkbox"
                  checked={selected && selected.size === detected.length}
                  onChange={e => handleSelectAll(e.target.checked)}
                />
                Select all
              </label>
            )}
          </div>
          {detected.map((d, i) => (
            <div key={i} style={{
              display: "flex", alignItems: "center", gap: ".5rem", padding: ".45rem .65rem",
              background: selected && selected.has(i) ? "var(--accent-14)" : "var(--s2)",
              border: `1px solid ${selected && selected.has(i) ? "var(--accent)" : "var(--b2)"}`,
              borderRadius: "8px", cursor: "pointer", transition: "all .2s"
            }}
              onClick={() => handleDetectedClick(d, i)}
              onMouseEnter={e => { if (!selected || !selected.has(i)) e.currentTarget.style.borderColor = "var(--accent)"; }}
              onMouseLeave={e => { if (!selected || !selected.has(i)) e.currentTarget.style.borderColor = "var(--b2)"; }}>
              {detected.length > 1 && (
                <input type="checkbox" checked={selected && selected.has(i)} readOnly
                  style={{ accentColor: "var(--accent)", cursor: "pointer" }} />
              )}
              <span style={{ fontSize: ".7rem", fontWeight: 700, color: "var(--accent)", textTransform: "uppercase", minWidth: "50px" }}>{d.type}</span>
              <span style={{ fontSize: ".78rem", color: "var(--t1)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.label}</span>
              {detected.length === 1 && <span style={{ fontSize: ".65rem", color: "var(--t3)" }}>Click to fill</span>}
            </div>
          ))}
          {selected && selected.size > 0 && (
            <button className="btn-primary" style={{ marginTop: ".4rem" }}
              onClick={() => {
                const items = [...selected].sort((a, b) => a - b).map(i => detected[i]);
                if (onImportMultiple) onImportMultiple(items);
              }}>
              Import {selected.size} connection{selected.size > 1 ? "s" : ""}
            </button>
          )}
        </div>
      )}
      {rawText && (!detected || detected.length === 0) && (
        <div style={{ fontSize: ".78rem", color: "var(--t3)", padding: ".5rem 0" }}>No connections detected</div>
      )}
    </div>
  );
}