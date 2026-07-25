/**
 * Connection object builders for E2E tests.
 *
 * All values use reserved test domains (provider.test, media.test, etc.)
 * so no real provider is ever contacted.
 */

let _idCounter = 0;

function nextId(prefix) {
  _idCounter += 1;
  return `${prefix}-${_idCounter}`;
}

export function buildXtreamConnection(overrides = {}) {
  return {
    id: nextId("xtream"),
    type: "xtream",
    label: "Test Xtream",
    config: {
      type: "xtream",
      server: "http://provider.test",
      user: "test-user",
      pass: "test-pass",
    },
    ...overrides,
  };
}

export function buildM3UConnection(overrides = {}) {
  return {
    id: nextId("m3u"),
    type: "m3u",
    label: "Test M3U",
    config: {
      type: "m3u",
      url: "http://provider.test/playlist.m3u",
    },
    ...overrides,
  };
}

export function buildStalkerConnection(overrides = {}) {
  return {
    id: nextId("stalker"),
    type: "stalker",
    label: "Test Stalker",
    config: {
      type: "stalker",
      server: "http://portal.test",
      mac: "00:1A:79:00:00:01",
    },
    ...overrides,
  };
}
