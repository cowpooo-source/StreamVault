import { describe, expect, it, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import React from "react";
import {
  getConnectionLifecycle,
  lifecycleFailureMessage,
  mergeConnectionSnapshots,
  mergeConnectionsWithinLimit,
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
      FRAG_LOADED: "fragLoaded",
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

function installMockMpegts() {
  const instances = [];
  const Events = { ERROR: "error", LOADING_COMPLETE: "loadingComplete" };
  window.mpegts = {
    Events,
    isSupported: () => true,
    createPlayer: vi.fn(config => {
      const player = {
        config,
        handlers: {},
        on: vi.fn((event, handler) => { player.handlers[event] = handler; }),
        attachMediaElement: vi.fn(),
        load: vi.fn(),
        play: vi.fn(() => Promise.resolve()),
        unload: vi.fn(),
        destroy: vi.fn(),
      };
      instances.push(player);
      return player;
    }),
  };
  return { instances, Events };
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

  it("merges persisted and in-memory connection snapshots without losing entries", () => {
    const stored = [
      { id: "one", type: "xtream", label: "stale", config: { server: "http://old" } },
    ];
    const current = [
      { id: "one", type: "xtream", label: "current", config: { server: "http://new" } },
      { id: "two", type: "stalker", config: { server: "http://portal", mac: "00:11:22:33:44:55" } },
    ];

    const merged = mergeConnectionSnapshots(stored, current);
    expect(merged).toHaveLength(2);
    expect(merged.find(connection => connection.id === "one")?.label).toBe("current");
    expect(merged.map(connection => connection.id)).toEqual(["one", "two"]);
  });
  it("caps imported connections at the account limit", () => {
    const existing = [{ id: "one", type: "xtream", config: { server: "http://one" } }];
    const incoming = [
      { id: "one", type: "xtream", config: { server: "http://duplicate" } },
      { id: "two", type: "m3u", config: { url: "http://two" } },
      { id: "three", type: "m3u", config: { url: "http://three" } },
    ];
    const result = mergeConnectionsWithinLimit(existing, incoming, 2);
    expect(result.connections.map(connection => connection.id)).toEqual(["one", "two"]);
    expect(result.added).toHaveLength(1);
    expect(result.skipped).toBe(1);
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
      _stalkerCmd: "ffmpeg http://portal/play/1?play_token=secret&keep=1",
    });

    expect(stable).toMatchObject({
      id: "stalker-1",
      name: "Channel",
      _stalkerCmd: "ffmpeg http://portal/play/1?keep=1",
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
    expect(directPlayer.loadSource).toHaveBeenCalledWith(expect.stringContaining("_sv_live="));
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
  it("does not reconnect a direct MPEG-TS stream only because its loader completes", async () => {
    vi.useFakeTimers();
    try {
      const { instances, Events } = installMockMpegts();
      const directUrl = "http://provider.example/live/channel.ts";
      render(<Player
        item={{ id: "closing-ts", name: "Closing TS", url: directUrl, type: "live", streamKind: "ts", _direct: true }}
        channelList={[]} epgData={null} onClose={vi.fn()} onFav={vi.fn()} isFav={() => false}
        connType="xtream" t={key => key} isAdEligible={false}
      />);

      expect(instances).toHaveLength(1);
      expect(instances[0].handlers[Events.LOADING_COMPLETE]).toBeUndefined();
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnects direct MPEG-TS only after playback makes no progress for seven seconds", async () => {
    vi.useFakeTimers();
    try {
      const { instances } = installMockMpegts();
      const { container } = render(<Player
        item={{ id: "stalled-ts", name: "Stalled TS", url: "http://provider.example/live/channel.ts", type: "live", streamKind: "ts", _direct: true }}
        channelList={[]} epgData={null} onClose={vi.fn()} onFav={vi.fn()} isFav={() => false}
        connType="xtream" t={key => key} isAdEligible={false}
      />);
      const video = container.querySelector("video");
      Object.defineProperty(video, "paused", { configurable: true, get: () => false });
      Object.defineProperty(video, "ended", { configurable: true, get: () => false });

      await act(async () => {
        fireEvent.playing(video);
        await vi.advanceTimersByTimeAsync(6_999);
      });
      expect(instances).toHaveLength(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(1_001); });
      expect(instances).toHaveLength(2);
      expect(instances[1].config.url).toBe("http://provider.example/live/channel.ts");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores duplicate network errors from a replaced MPEG-TS player", async () => {
    vi.useFakeTimers();
    try {
      const { instances, Events } = installMockMpegts();
      render(<Player
        item={{ id: "duplicate-error-ts", name: "Duplicate Error TS", url: "http://provider.example/live/channel.ts", type: "live", streamKind: "ts", _direct: true }}
        channelList={[]} epgData={null} onClose={vi.fn()} onFav={vi.fn()} isFav={() => false}
        connType="xtream" t={key => key} isAdEligible={false}
      />);
      const failedPlayer = instances[0];

      await act(async () => {
        await failedPlayer.handlers[Events.ERROR]("NetworkError", "network disconnected", {});
        await failedPlayer.handlers[Events.ERROR]("NetworkError", "duplicate disconnect", {});
        await vi.advanceTimersByTimeAsync(500);
      });

      expect(instances).toHaveLength(2);
      expect(screen.queryByText("Playback Error")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
  it("stops reconnecting MPEG-TS after three network failures per minute", async () => {
    vi.useFakeTimers();
    try {
      const { instances, Events } = installMockMpegts();
      render(<Player
        item={{ id: "looping-ts", name: "Looping TS", url: "http://provider.example/live/channel.ts", type: "live", streamKind: "ts", _direct: true }}
        channelList={[]} epgData={null} onClose={vi.fn()} onFav={vi.fn()} isFav={() => false}
        connType="xtream" t={key => key} isAdEligible={false}
      />);

      for (const delay of [500, 1000, 2000]) {
        const player = instances.at(-1);
        await act(async () => {
          await player.handlers[Events.ERROR]("NetworkError", "network disconnected", {});
          await vi.advanceTimersByTimeAsync(delay);
        });
      }
      expect(instances).toHaveLength(4);

      await act(async () => {
        await instances.at(-1).handlers[Events.ERROR]("NetworkError", "network disconnected", {});
      });

      expect(instances).toHaveLength(4);
      expect(screen.getByText("Stream Disconnected")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets accumulated HLS errors after a fragment loads successfully", async () => {
    const { instances, MockHls } = installMockHls();
    const onRefreshStream = vi.fn();
    render(<Player
      item={{ id: "stable-hls", name: "Stable HLS", url: "http://provider.example/live.m3u8", type: "live", streamKind: "hls", _direct: true, _stalkerCmd: "channel" }}
      channelList={[]} epgData={null} onClose={vi.fn()} onFav={vi.fn()} isFav={() => false}
      onRefreshStream={onRefreshStream} connType="stalker" t={key => key} isAdEligible={false}
    />);
    await waitFor(() => expect(instances).toHaveLength(1));
    const failure = { fatal: true, type: MockHls.ErrorTypes.NETWORK_ERROR, details: "fragLoadError", response: { code: 500 } };
    await act(async () => {
      await instances[0].handlers.error(null, failure);
      await instances[0].handlers.error(null, failure);
      instances[0].handlers.fragLoaded();
      await instances[0].handlers.error(null, failure);
    });
    expect(onRefreshStream).not.toHaveBeenCalled();
  });

  it("never activates Stalker relay automatically, even when relay is available", async () => {
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
        _stalkerCmd: "ffrt http:///ch/123",
        _stalkerRefreshUrl: `${fallbackUrl}&resolve=1`,
        _stalkerRelayAvailable: true,
        _stalkerDirectOnly: false,
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
    const failure = { fatal: true, type: MockHls.ErrorTypes.NETWORK_ERROR, details: "manifestLoadError" };
    await act(async () => {
      await instances[0].handlers.error(null, failure);
      await instances[0].handlers.error(null, failure);
      await instances[0].handlers.error(null, failure);
    });

    expect(instances.every(instance => instance.loadSource.mock.calls.every(([url]) =>
      !url.includes(fallbackUrl) && !url.startsWith("/stream?url=")
    ))).toBe(true);
    expect(await screen.findByText("Direct Playback Incompatible")).toBeInTheDocument();
  });
  it("requires confirmation and shows an indicator for emergency relay", async () => {
    const { instances, MockHls } = installMockHls();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const onRequestRelay = vi.fn().mockResolvedValue({
      id: "stalker-relay", name: "Stalker Relay", type: "live", streamKind: "hls",
      url: "/stalker/play?contentToken=opaque&cmd=reference&relayGrant=signed",
      _stalkerCmd: "svopaque:reference", _stalkerRelayAvailable: true, _stalkerRelayActive: true,
    });
    render(<Player
      item={{ id: "stalker-relay", name: "Stalker Relay", url: "http://provider.example/live.m3u8", type: "live", streamKind: "hls", _direct: true, _stalkerCmd: "svopaque:reference", _stalkerRefreshUrl: "/stalker/play?contentToken=opaque&cmd=reference&resolve=1", _stalkerRelayUrl: "/stalker/play?contentToken=opaque&cmd=reference", _stalkerRelayAvailable: true }}
      channelList={[]} epgData={null} onClose={vi.fn()} onFav={vi.fn()} isFav={() => false}
      onRequestRelay={onRequestRelay} connType="stalker" t={key => key} isAdEligible={false}
    />);
    await waitFor(() => expect(instances).toHaveLength(1));
    const failure = { fatal: true, type: MockHls.ErrorTypes.NETWORK_ERROR, details: "manifestLoadError" };
    await act(async () => {
      await instances[0].handlers.error(null, failure);
      await instances[0].handlers.error(null, failure);
      await instances[0].handlers.error(null, failure);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Use Compatibility Relay" }));
    await waitFor(() => expect(onRequestRelay).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Compatibility relay active")).toBeInTheDocument();
    confirm.mockRestore();
  });

  it("does not relay when a direct Stalker stream fails", async () => {
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

    await waitFor(() => expect(screen.getByText(/Playback Error/i)).toBeInTheDocument());
    expect(video.src).not.toContain(fallbackUrl);
  });

  it("keeps direct Stalker VOD files out of the stream relay", () => {
    const directUrl = "http://provider.example/movie.mp4?token=opaque";
    render(<Player
      item={{
        id: "stalker-vod-direct",
        name: "Stalker VOD",
        url: directUrl,
        type: "vod",
        streamKind: "file",
        _direct: true,
        _stalkerCmd: "/media/movie.mpg",
        _stalkerDirectOnly: true,
      }}
      channelList={[]} epgData={null} onClose={vi.fn()} onFav={vi.fn()} isFav={() => false}
      connType="stalker" t={key => key} isAdEligible={false}
    />);

    const video = document.querySelector("video");
    expect(video.src).toContain(directUrl);
    expect(video.src).not.toContain("/stream?url=");
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

  it("refreshes native Stalker VOD before browser retries can stall playback", async () => {
    vi.useFakeTimers();
    try {
      const onRefreshStream = vi.fn().mockResolvedValue({
        url: "http://provider.example/new-vod-url",
        type: "vod",
        streamKind: "file",
        _direct: true,
        _stalkerCmd: "/media/movie.mpg",
      });
      render(<Player
        item={{
          id: "stalker-vod-timeout",
          name: "Stalker VOD",
          url: "http://provider.example/extensionless-vod-url",
          type: "vod",
          streamKind: "unknown",
          _direct: true,
          _stalkerCmd: "/media/movie.mpg",
        }}
        channelList={[]} epgData={null} onClose={vi.fn()} onFav={vi.fn()} isFav={() => false}
        onRefreshStream={onRefreshStream} connType="stalker" t={key => key} isAdEligible={false}
      />);

      await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
      expect(onRefreshStream).toHaveBeenCalledWith(expect.objectContaining({ id: "stalker-vod-timeout" }), "initial_load_timeout");
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not refresh native Stalker VOD that has started receiving media", async () => {
    vi.useFakeTimers();
    try {
      const onRefreshStream = vi.fn();
      render(<Player
        item={{
          id: "slow-stalker-vod",
          name: "Slow Stalker VOD",
          url: "http://provider.example/slow-vod-url",
          type: "vod",
          streamKind: "unknown",
          _direct: true,
          _stalkerCmd: "/media/slow.mpg",
        }}
        channelList={[]} epgData={null} onClose={vi.fn()} onFav={vi.fn()} isFav={() => false}
        onRefreshStream={onRefreshStream} connType="stalker" t={key => key} isAdEligible={false}
      />);
      const video = document.querySelector("video");
      Object.defineProperty(video, "readyState", { configurable: true, value: 2 });

      await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });

      expect(onRefreshStream).not.toHaveBeenCalled();
      expect(screen.queryByText("Playback Timeout")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a stale VOD refresh stop a newly selected channel", async () => {
    vi.useFakeTimers();
    try {
      let resolveRefresh;
      const onRefreshStream = vi.fn(() => new Promise(resolve => { resolveRefresh = resolve; }));
      const first = {
        id: "old-channel", name: "Old Channel", url: "http://provider.example/old",
        type: "live", streamKind: "unknown", _direct: true, _stalkerCmd: "old",
      };
      const second = {
        id: "new-channel", name: "New Channel", url: "http://provider.example/new.mp4",
        type: "live", streamKind: "file", _direct: true, _stalkerCmd: "new",
      };
      render(<Player
        item={first} channelList={[first, second]} epgData={null} onClose={vi.fn()}
        onFav={vi.fn()} isFav={() => false} onRefreshStream={onRefreshStream}
        connType="stalker" t={key => key} isAdEligible={false}
      />);

      await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
      fireEvent.keyDown(window, { key: "ArrowRight" });
      await act(async () => {});
      await act(async () => {
        resolveRefresh({ ...first, url: "http://provider.example/refreshed-old" });
        await Promise.resolve();
      });

      expect(document.querySelector("video").src).toContain(second.url);
      expect(screen.queryByText("Playback Timeout")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves VOD position when initial-load recovery aborts the source", async () => {
    vi.useFakeTimers();
    try {
      const onRefreshStream = vi.fn().mockResolvedValue({
        url: "http://provider.example/refreshed-vod",
        type: "vod",
        streamKind: "file",
        _direct: true,
        _stalkerCmd: "/media/movie.mpg",
      });
      render(<Player
        item={{
          id: "positioned-vod", name: "Positioned VOD", url: "http://provider.example/original-vod",
          type: "vod", streamKind: "unknown", _direct: true, _stalkerCmd: "/media/movie.mpg",
        }}
        channelList={[]} epgData={null} onClose={vi.fn()} onFav={vi.fn()} isFav={() => false}
        onRefreshStream={onRefreshStream} connType="stalker" t={key => key} isAdEligible={false}
      />);
      const video = document.querySelector("video");
      Object.defineProperty(video, "duration", { configurable: true, value: 600 });
      video.currentTime = 120;
      video.load.mockImplementation(() => { video.currentTime = 0; });

      await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
      fireEvent.loadedMetadata(video);

      expect(video.currentTime).toBe(120);
    } finally {
      vi.useRealTimers();
    }
  });
  it("refreshes a direct Stalker stream when playback silently stalls", async () => {
    vi.useFakeTimers();
    try {
      const directUrl = "http://provider.example/direct/channel.ts";
      const onRefreshStream = vi.fn().mockResolvedValue({ url: directUrl, streamKind: "ts", _direct: true });
      render(<Player
        item={{ id: "silent-stall", name: "Silent Stall", url: directUrl, type: "live", _direct: true, _stalkerFallbackUrl: "/stalker/play?contentToken=opaque" }}
        channelList={[]} epgData={null} onClose={vi.fn()} onFav={vi.fn()} isFav={() => false}
        onRefreshStream={onRefreshStream} connType="stalker" t={key => key} isAdEligible={false}
      />);
      const video = document.querySelector("video");
      Object.defineProperty(video, "paused", { configurable: true, value: false });
      Object.defineProperty(video, "ended", { configurable: true, value: false });

      await act(async () => {});
      video.currentTime = 0.1;
      fireEvent.playing(video);
      fireEvent.stalled(video);
      await act(async () => { await vi.advanceTimersByTimeAsync(8000); });

      expect(onRefreshStream).toHaveBeenCalledOnce();
      expect(onRefreshStream).toHaveBeenCalledWith(expect.objectContaining({ id: "silent-stall" }), "playback_progress_timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores VOD position after recovering from a silent stall", async () => {
    vi.useFakeTimers();
    try {
      render(<Player
        item={{ id: "vod-stall", name: "VOD Stall", url: "http://provider.example/movie.mp4", type: "vod", streamKind: "file" }}
        channelList={[]} epgData={null} onClose={vi.fn()} onFav={vi.fn()} isFav={() => false}
        connType="xtream" t={key => key} isAdEligible={false}
      />);
      const video = document.querySelector("video");
      Object.defineProperty(video, "paused", { configurable: true, value: false });
      Object.defineProperty(video, "ended", { configurable: true, value: false });
      Object.defineProperty(video, "duration", { configurable: true, value: 600 });
      video.currentTime = 120;

      await act(async () => {});
      fireEvent.playing(video);
      fireEvent.stalled(video);
      await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
      video.currentTime = 0;
      fireEvent.loadedMetadata(video);

      expect(video.currentTime).toBe(120);
    } finally {
      vi.useRealTimers();
    }
  });
  it("restores VOD position after an explicit native retry", () => {
    render(<Player
      item={{ id: "vod-retry", name: "VOD Retry", url: "http://provider.example/movie.mp4", type: "vod", streamKind: "file" }}
      channelList={[]} epgData={null} onClose={vi.fn()} onFav={vi.fn()} isFav={() => false}
      connType="xtream" t={key => key} isAdEligible={false}
    />);
    const video = document.querySelector("video");
    Object.defineProperty(video, "duration", { configurable: true, value: 600 });
    video.currentTime = 120;
    fireEvent.error(video);
    fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
    video.currentTime = 0;
    fireEvent.loadedMetadata(video);

    expect(video.currentTime).toBe(120);
  });
});
