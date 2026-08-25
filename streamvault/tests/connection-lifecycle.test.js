import { describe, expect, it } from "vitest";
import { activeConnectionStorageKey, resolveActiveConnectionId } from "../src/connection-lifecycle.js";

const stalker = {
  id: "stalker:http://portal.test:00:1A:79:00:00:01",
  type: "stalker",
  config: { server: "http://portal.test", mac: "00:1A:79:00:00:01" },
};

describe("active connection persistence", () => {
  it("uses an opaque key instead of storing the connection ID", async () => {
    const key = await activeConnectionStorageKey(stalker.id);

    expect(key).toMatch(/^sv-active-v2:/);
    expect(key).not.toContain(stalker.id);
    expect(key).not.toContain(stalker.config.mac);
  });

  it("resolves opaque keys and migrates legacy IDs", async () => {
    const key = await activeConnectionStorageKey(stalker.id);

    await expect(resolveActiveConnectionId(key, [stalker])).resolves.toBe(stalker.id);
    await expect(resolveActiveConnectionId(stalker.id, [stalker])).resolves.toBe(stalker.id);
    await expect(resolveActiveConnectionId("sv-active-v2:missing", [stalker])).resolves.toBeNull();
  });
});
