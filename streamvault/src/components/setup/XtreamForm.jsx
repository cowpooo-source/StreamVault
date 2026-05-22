import React from "react";

/**
 * XtreamForm - Xtream Codes server/user/pass form
 * @param {{ form: object, setForm: function, loading: boolean, err: string, onSubmit: function }} props
 */
export function XtreamForm({ form, setForm, loading, err, onSubmit }) {
  const set = (k, v) => setForm(k, v);
  return (
    <>
      <div className="fg">
        <label className="fl">Server URL</label>
        <input
          className="fi"
          placeholder="http://server.com:8080"
          value={form.server}
          onChange={e => set("server", e.target.value)}
        />
      </div>
      <div className="fg">
        <label className="fl">Username</label>
        <input
          className="fi"
          placeholder="username"
          value={form.user}
          onChange={e => set("user", e.target.value)}
        />
      </div>
      <div className="fg">
        <label className="fl">Password</label>
        <input
          className="fi"
          type="password"
          placeholder="password"
          value={form.pass}
          onChange={e => set("pass", e.target.value)}
          onKeyDown={e => e.key === "Enter" && onSubmit()}
        />
      </div>
    </>
  );
}