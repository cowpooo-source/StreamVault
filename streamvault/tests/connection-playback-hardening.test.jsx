import { describe, expect, it, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import React from "react";
import {
  getConnectionLifecycle,
  lifecycleFailureMessage,
  normalizeConnections,
} from "../src/connection-lifecycle.js";
import { classifyStreamUrl } from "../src/stream-classifier.js";
import { shouldProxyStreamUrl, stripTransientStreamFields } from "../src/stream-routing.js";

vi.mock("../src/vast.js", () => ({ fetchVastAd: vi.fn(() => null) }));
vi.mock("../src/epg.js", () => ({ getEPGNow: vi.fn(() => null) }));
import Player from "../src/components/Player.jsx";

function installMockHls() {
  const instances = [];
  class MockHls {
    static isSupported = () => true;
    static Events = {
      ERROR: "error",
      MANIFEST_PARSED: "manifestParsed",
      AUDIO_TRACKS_UPDATED: "audioTracksUpdated",
      SUBTITLE_TRACKS_UPDATED: "subtitleTracksUpdated",
      AUDIO_TRACK_SWITCHED: "audioTrackSwitched",
      SUBTITLE_TRACK_SWITCH: "subtitleTrackSwitch",
    };
    static ErrorTypes = { NETWORK_ERROR: "networkError", MEDIA_ERROR: "mediaError" };
    constructor() {
      this.handlers = {};
      this.audioTracks = [];
      this.subtitleTracks = [];
      this.audioTrack = -1;
      this.subtitleTrack = -1;
      this.loadSource = vi.fn();
      this.attachMedia = vi.fn();
      this.startLoad = vi.fn();
      this.recoverMediaError = vi.fn();
      this.destroy = vi.fn();
      instances.push(this);
    }
    on(event, handler) { this.handlers[event] = handler; }
  }
  window.Hls = MockHls;
  return { instances, MockHls };
}

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
  it("forces secure-page direct playback through the proxy for HTTP HLS and TS streams", () => {
    const options = {
      origin: "https://media.portalheaven.stream",
      pageProtocol: "https:",
      direct: true,
    };

    expect(shouldProxyStreamUrl("http://provider/live/index.m3u8", { ...options, kind: "hls" })).toBe(true);
    expect(shouldProxyStreamUrl("http://provider/live/stream.ts", { ...options, kind: "ts" })).toBe(true);
    expect(shouldProxyStreamUrl("https://provider/live/index.m3u8", { ...options, kind: "hls" })).toBe(true);
    expect(shouldProxyStreamUrl("https://media.portalheaven.stream/stream?url=https%3A%2F%2Fprovider%2Flive%2Findex.m3u8", { ...options, kind: "hls" })).toBe(false);
  });

  it("removes generated Stalker URLs before persistence", () => {
    const stable = stripTransientStreamFields({
      id: "stalker-1",
      name: "Channel",
      url: "http://provider/tokenized.ts",
      directUrl: "http://provider/tokenized.ts",
      expiresAt: 123,
      _direct: true,
      _stalkerFallbackUrl: "/stalker/play?portal=secret",
      _stalkerFallbackUsed: false,
      _stalkerCmd: "ffmpeg http://portal/play/1",
    });

    expect(stable).toMatchObject({
      id: "stalker-1",
      name: "Channel",
      _stalkerCmd: "ffmpeg http://portal/play/1",
    });
    expect(stable).not.toHaveProperty("url");
    expect(stable).not.toHaveProperty("directUrl");
    expect(stable).not.toHaveProperty("_stalkerFallbackUrl");
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
  it("falls back through /stream after direct HLS network retries fail without an HTTP status", async () => {
    const { instances, MockHls } = installMockHls();


    const directUrl = "http://provider.example/live/channel.m3u8?token=test";
    render(<Player
      item={{ id: "cors-hls", name: "CORS HLS", url: directUrl, type: "live", streamKind: "hls", _direct: true }}
      channelList={[]}
      epgData={null}
      onClose={vi.fn()}
      onFav={vi.fn()}
      isFav={() => false}
      connType="xtream"
      t={key => key}
      isAdEligible={false}
    />);

    await waitFor(() => expect(instances).toHaveLength(1));
    const directPlayer = instances[0];
    const fatalNetworkError = { fatal: true, type: MockHls.ErrorTypes.NETWORK_ERROR, details: "manifestLoadError" };

    await act(async () => {
      await directPlayer.handlers.error(null, fatalNetworkError);
      await directPlayer.handlers.error(null, fatalNetworkError);
      await directPlayer.handlers.error(null, fatalNetworkError);
    });

    await waitFor(() => {
      expect(instances.some(instance => instance.loadSource.mock.calls.some(([url]) =>
        url.startsWith("/stream?url=") && decodeURIComponent(url).includes(directUrl)
      ))).toBe(true);
    });
    expect(screen.queryByText(/Playback Error/i)).not.toBeInTheDocument();
  });
  it("uses the authenticated Stalker fallback for direct HLS CORS failures", async () => {
    const { instances, MockHls } = installMockHls();
    const fallbackUrl = "/stalker/play?contentToken=opaque&cmd=channel";
    render(<Player
      item={{
        id: "stalker-hls",
        name: "Stalker HLS",
        url: "http://provider.example/live/channel.m3u8",
        type: "live",
        streamKind: "hls",
        _direct: true,
        _stalkerFallbackUrl: fallbackUrl,
      }}
      channelList={[]}
      epgData={null}
      onClose={vi.fn()}
      onFav={vi.fn()}
      isFav={() => false}
      connType="stalker"
      t={key => key}
      isAdEligible={false}
    />);

    await waitFor(() => expect(instances).toHaveLength(1));
    await act(async () => {
      await instances[0].handlers.error(null, {
        fatal: true,
        type: MockHls.ErrorTypes.NETWORK_ERROR,
        details: "manifestLoadError",
      });
    });

    await waitFor(() => {
      expect(instances.some(instance => instance.loadSource.mock.calls.some(([url]) =>
        url.includes(fallbackUrl)
      ))).toBe(true);
    });
    expect(instances.every(instance => instance.loadSource.mock.calls.every(([url]) =>
      !url.startsWith("/stream?url=")
    ))).toBe(true);
  });
  it("falls back once when a direct Stalker stream fails", async () => {
    const fallbackUrl = "/stalker/play?portal=example&cmd=channel";
    const videoProps = {
      item: {
        id: "stalker-1",
        name: "Stalker Live",
        url: "http://provider.example/direct/channel.ts",
        type: "live",
        _direct: true,
        _stalkerFallbackUrl: fallbackUrl,
      },
      channelList: [], epgData: null, onClose: vi.fn(), onFav: vi.fn(), isFav: () => false,
      connType: "stalker", t: (key) => key, isAdEligible: false,
    };
    render(<Player {...videoProps} />);
    const video = document.querySelector("video");

    fireEvent.error(video);

    await waitFor(() => expect(video.src).toContain(fallbackUrl));
    expect(screen.queryByText(/Playback Error/i)).not.toBeInTheDocument();
  });

  it("reinitializes playback when Stalker refresh returns the same URL", async () => {
    const directUrl = "http://provider.example/direct/channel.ts";
    const onRefreshStream = vi.fn().mockResolvedValue({
      url: directUrl,
      streamKind: "ts",
      _direct: true,
    });
    render(<Player
      item={{
        id: "stalker-refresh",
        name: "Stalker Refresh",
        url: directUrl,
        type: "live",
        _direct: true,
        _stalkerCmd: "channel",
        _stalkerFallbackUrl: "/stalker/play?connection=opaque&content=channel",
      }}
      channelList={[]}
      epgData={null}
      onClose={vi.fn()}
      onFav={vi.fn()}
      isFav={() => false}
      onRefreshStream={onRefreshStream}
      connType="stalker"
      t={key => key}
      isAdEligible={false}
    />);
    const video = document.querySelector("video");
    const loadsBeforeError = video.load.mock.calls.length;

    fireEvent.error(video);

    await waitFor(() => expect(onRefreshStream).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(video.load.mock.calls.length).toBeGreaterThan(loadsBeforeError));
    fireEvent.error(video);
    await waitFor(() => expect(onRefreshStream).toHaveBeenCalledTimes(2));
  });
});
