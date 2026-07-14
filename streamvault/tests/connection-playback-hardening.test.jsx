import { describe, expect, it, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import {
  getConnectionLifecycle,
  lifecycleFailureMessage,
  normalizeConnections,
} from "../src/connection-lifecycle.js";
import { classifyStreamUrl } from "../src/stream-classifier.js";

vi.mock("../src/vast.js", () => ({ fetchVastAd: vi.fn(() => null) }));
vi.mock("../src/epg.js", () => ({ getEPGNow: vi.fn(() => null) }));
import Player from "../src/components/Player.jsx";

describe("connection and playback hardening", () => {
  beforeEach(() => {
    window.Hls = { isSupported: () => false, Events: {}, ErrorTypes: {} };
    window.mpegts = { isSupported: () => false, Events: {} };
    HTMLVideoElement.prototype.play = vi.fn(() => Promise.resolve());
    HTMLVideoElement.prototype.pause = vi.fn();
    HTMLVideoElement.prototype.load = vi.fn();
    HTMLVideoElement.prototype.removeAttribute = vi.fn();
  });

  it("hydrates only valid, unique connection records", () => {
    expect(normalizeConnections([
      { id: "one", type: "xtream", config: { server: "http://one" } },
      { id: "one", type: "m3u", config: { url: "http://duplicate" } },
      { id: "missing-type", config: {} },
      null,
    ])).toEqual([
      { id: "one", type: "xtream", label: "xtream connection", config: { server: "http://one" } },
    ]);
  });

  it("recognizes disabled and expired provider accounts", () => {
    const expired = { type: "xtream", config: { accountInfo: { exp_date: "1700000000" } } };
    const disabled = { type: "xtream", config: { accountInfo: { status: "Disabled" } } };
    expect(getConnectionLifecycle(expired, 1700000000001).expired).toBe(true);
    expect(lifecycleFailureMessage(expired, 1700000000001)).toContain("expired");
    expect(getConnectionLifecycle(disabled).valid).toBe(false);
    expect(lifecycleFailureMessage(disabled)).toContain("disabled");
  });

  it("classifies extensionless live and provider VOD URLs", () => {
    expect(classifyStreamUrl("http://provider/live/play/token/840584", "live")).toBe("ts");
    expect(classifyStreamUrl("http://provider/movie/user/pass/465708.mkv", "vod")).toBe("file");
    expect(classifyStreamUrl("http://provider/playlist?extension=ts", "live")).toBe("ts");
    expect(classifyStreamUrl("http://provider/live/index.m3u8", "live")).toBe("hls");
  });

  it("retries a failed bare live stream in the same player", () => {
    const videoProps = {
      item: { id: "live-1", name: "Live", url: "http://provider/live/play/token/840584", type: "live" },
      channelList: [], epgData: null, onClose: vi.fn(), onFav: vi.fn(), isFav: () => false,
      connType: "xtream", t: (key) => key, isAdEligible: false,
    };
    render(<Player {...videoProps} />);
    const video = document.querySelector("video");
    fireEvent.error(video);
    expect(screen.getByRole("button", { name: "Try Again" })).toBeInTheDocument();
    const loadsBeforeRetry = video.load.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
    expect(video.load.mock.calls.length).toBeGreaterThan(loadsBeforeRetry);
  });
});
