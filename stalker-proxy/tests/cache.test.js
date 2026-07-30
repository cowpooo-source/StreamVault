import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import os from "os";

const TEST_DB = path.join(os.tmpdir(), `streamvault-test-cache-${process.pid}.db`);

let cache;

beforeAll(() => {
  try { fs.unlinkSync(TEST_DB); } catch {}
  process.env.CACHE_DB = TEST_DB;
  cache = require("../src/cache");
});

afterAll(() => {
  try { fs.unlinkSync(TEST_DB); } catch {}
  try { fs.unlinkSync(TEST_DB + "-wal"); } catch {}
  try { fs.unlinkSync(TEST_DB + "-shm"); } catch {}
});

describe("Cache — Get/Set/Delete", () => {
  it("returns null for missing key", () => {
    expect(cache.get("nonexistent")).toBeNull();
  });

  it("sets and gets a value", () => {
    cache.set("test-key", { hello: "world" });
    expect(cache.get("test-key")).toEqual({ hello: "world" });
  });

  it("overwrites existing key", () => {
    cache.set("test-key", { updated: true });
    expect(cache.get("test-key")).toEqual({ updated: true });
  });

  it("deletes a key", () => {
    cache.set("del-me", "value");
    cache.del("del-me");
    expect(cache.get("del-me")).toBeNull();
  });

  it("respects TTL expiry", () => {
    cache.set("short-ttl", "data", 1); // 1ms TTL
    // Wait a tiny bit for expiry
    const start = Date.now();
    while (Date.now() - start < 5) {} // busy wait 5ms
    expect(cache.get("short-ttl")).toBeNull();
  });

  it("stores complex objects", () => {
    const data = { channels: [{ id: 1, name: "CH1" }], count: 1, nested: { a: [1, 2] } };
    cache.set("complex", data);
    expect(cache.get("complex")).toEqual(data);
  });
});

describe("Cache — Guest Data (Sync)", () => {
  it("saves and retrieves guest data", () => {
    cache.saveGuestData("guest:abc", "conn1", "favorites", { live: { ch1: true } });
    const data = cache.getGuestData("guest:abc", "conn1", "favorites");
    expect(data).toEqual({ live: { ch1: true } });
  });

  it("returns null for missing guest data", () => {
    expect(cache.getGuestData("guest:xxx", "conn1", "favorites")).toBeNull();
  });

  it("overwrites existing guest data", () => {
    cache.saveGuestData("guest:abc", "conn1", "favorites", { live: { ch2: true } });
    const data = cache.getGuestData("guest:abc", "conn1", "favorites");
    expect(data).toEqual({ live: { ch2: true } });
  });

  it("separates data by type", () => {
    cache.saveGuestData("guest:abc", "conn1", "history", [{ id: 1 }]);
    expect(cache.getGuestData("guest:abc", "conn1", "favorites")).toEqual({ live: { ch2: true } });
    expect(cache.getGuestData("guest:abc", "conn1", "history")).toEqual([{ id: 1 }]);
  });

  it("separates data by connId", () => {
    cache.saveGuestData("guest:abc", "conn2", "favorites", { vod: {} });
    expect(cache.getGuestData("guest:abc", "conn1", "favorites")).toEqual({ live: { ch2: true } });
    expect(cache.getGuestData("guest:abc", "conn2", "favorites")).toEqual({ vod: {} });
  });

  it("deletes guest data by connId", () => {
    cache.deleteGuestData("guest:abc", "conn1");
    expect(cache.getGuestData("guest:abc", "conn1", "favorites")).toBeNull();
    expect(cache.getGuestData("guest:abc", "conn1", "history")).toBeNull();
    // conn2 untouched
    expect(cache.getGuestData("guest:abc", "conn2", "favorites")).toEqual({ vod: {} });
  });

  it("expires anonymous guest sync data but preserves registered-user data", () => {
    cache.saveGuestData("guest:expired", "_all", "connections", "guest-data");
    cache.saveGuestData("user:durable", "_all", "connections", "user-data");
    cache.db.prepare("UPDATE guest_data SET updated_at = 0 WHERE guest_id IN (?, ?)")
      .run("guest:expired", "user:durable");

    cache.cleanupGuestData();

    expect(cache.getGuestData("guest:expired", "_all", "connections")).toBeNull();
    expect(cache.getGuestData("user:durable", "_all", "connections")).toBe("user-data");
  });
});

describe("Cache — Tracking", () => {
  it("tracks requests without error", () => {
    expect(() => cache.trackRequest("stalker")).not.toThrow();
    expect(() => cache.trackRequest("stream")).not.toThrow();
    expect(() => cache.trackRequest("other")).not.toThrow();
  });

  it("tracks visitors without error", () => {
    expect(() => cache.trackVisitor("1.2.3.4")).not.toThrow();
  });

  it("tracks portals without error", () => {
    expect(() => cache.trackPortal("http://test.com", "00:1A:79:00:00:00", "live")).not.toThrow();
  });

  it("saves and retrieves feedback", () => {
    cache.saveFeedback("Great app!", "guest123", "Chrome", "1.2.3.4");
    const feedback = cache.getFeedback();
    expect(feedback.length).toBeGreaterThanOrEqual(1);
    expect(feedback[0].message).toBe("Great app!");
  });

  it("getStats returns expected shape", () => {
    const stats = cache.getStats();
    expect(stats).toHaveProperty("cacheTotal");
    expect(stats).toHaveProperty("cacheValid");
    expect(stats).toHaveProperty("cacheSizeMB");
    expect(stats).toHaveProperty("todayReqs");
    expect(stats).toHaveProperty("visitors");
    expect(stats).toHaveProperty("guests");
  });
});

describe("Cache — Cleanup", () => {
  it("removes expired entries", () => {
    cache.set("expire-soon", "data", 1);
    const start = Date.now();
    while (Date.now() - start < 5) {}
    cache.cleanup();
    expect(cache.get("expire-soon")).toBeNull();
  });

  it("keeps non-expired entries", () => {
    cache.set("keep-me", "data", 60000);
    cache.cleanup();
    expect(cache.get("keep-me")).toEqual("data");
  });
});
