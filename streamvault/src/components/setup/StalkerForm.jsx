import React, { useState } from "react";

/**
 * StalkerForm - Stalker portal MAC, portal URL, serial, device ID fields
 * @param {{ form: object, setForm: function, loading: boolean, err: string, skipValidation: boolean, setSkipValidation: function, onSubmit: function, onValidate: function }} props
 */
export function StalkerForm({ form, setForm, skipValidation, setSkipValidation, onSubmit }) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const set = (k, v) => setForm(k, v);
  return (
    <>
      <div className="fg">
        <label className="fl">Portal URL</label>
        <input
          className="fi"
          placeholder="http://server/stalker_portal/c/"
          value={form.server}
          onChange={e => set("server", e.target.value)}
        />
      </div>
      <div className="fg">
        <label className="fl">MAC Address</label>
        <input
          className="fi"
          placeholder="00:1A:79:XX:XX:XX"
          value={form.mac}
          onChange={e => set("mac", e.target.value)}
          onKeyDown={e => e.key === "Enter" && onSubmit()}
        />
        <div className="fhint">The MAC address registered with your IPTV provider</div>
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: ".4rem", marginTop: ".5rem", cursor: "pointer", fontSize: ".72rem", color: "var(--t2)" }}>
        <input
          type="checkbox"
          checked={skipValidation}
          onChange={e => setSkipValidation(e.target.checked)}
          style={{ accentColor: "var(--accent)", cursor: "pointer" }}
        />
        Skip validation (connect without checking account status)
      </label>
      <div style={{ marginTop: ".5rem" }}>
        <button
          type="button"
          style={{ background: "none", border: "none", color: "var(--accent)", fontSize: ".72rem", cursor: "pointer", padding: 0, fontFamily: "'DM Sans',sans-serif" }}
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          {showAdvanced ? "▾ Hide advanced" : "▸ Advanced options"}
        </button>
      </div>
      {showAdvanced && (
        <>
          <div className="fg">
            <label className="fl">Serial Number</label>
            <input
              className="fi"
              placeholder="Optional — leave blank for auto"
              value={form.serial}
              onChange={e => set("serial", e.target.value)}
            />
            <div className="fhint">Device serial number (if required by provider)</div>
          </div>
          <div className="fg">
            <label className="fl">Device ID</label>
            <input
              className="fi"
              placeholder="Optional — used for both ID1 and ID2 if ID2 is blank"
              value={form.deviceId}
              onChange={e => set("deviceId", e.target.value)}
            />
            <div className="fhint">Primary device identifier</div>
          </div>
          <div className="fg">
            <label className="fl">Device ID 2</label>
            <input
              className="fi"
              placeholder="Optional — defaults to Device ID above"
              value={form.deviceId2}
              onChange={e => set("deviceId2", e.target.value)}
              onKeyDown={e => e.key === "Enter" && onSubmit()}
            />
            <div className="fhint">Secondary device identifier (some providers use same value for both)</div>
          </div>
        </>
      )}
    </>
  );
}
