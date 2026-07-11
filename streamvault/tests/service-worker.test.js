import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import process from "node:process";
import { resolve } from "node:path";

const source = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8");

describe("service worker cache policy", () => {
  it("leaves tokenized pages and sensitive APIs network-only", () => {
    expect(source).toContain('url.pathname === "/content"');
    expect(source).toContain('url.pathname === "/player"');
    expect(source).toContain('url.pathname.startsWith("/api/auth")');
    expect(source).toContain('url.pathname.startsWith("/api/content-session")');
  });

  it("pre-caches shell files independently", () => {
    expect(source).toContain("Promise.allSettled(APP_SHELL.map");
    expect(source).not.toContain("cache.addAll(APP_SHELL)");
  });

  it("prefers the requested cached document before the SPA fallback", () => {
    expect(source).toContain('(await caches.match(e.request)) || caches.match("/")');
  });
});
