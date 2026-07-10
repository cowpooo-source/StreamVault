import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

// Mock HLS and mpegts
Object.defineProperty(window, 'Hls', {
  value: { isSupported: vi.fn(() => false), Events: {}, ErrorTypes: {} },
  writable: true,
});
Object.defineProperty(window, 'mpegts', {
  value: { isSupported: vi.fn(() => false), createPlayer: vi.fn(), Events: {} },
  writable: true,
});

// Mock video element methods
beforeEach(() => {
  HTMLVideoElement.prototype.play = vi.fn(() => Promise.resolve());
  HTMLVideoElement.prototype.pause = vi.fn(() => Promise.resolve());
  HTMLVideoElement.prototype.load = vi.fn();
  HTMLVideoElement.prototype.removeAttribute = vi.fn();
  HTMLVideoElement.prototype.canPlayType = vi.fn(() => "maybe");
  HTMLVideoElement.prototype.requestPictureInPicture = vi.fn(() => Promise.resolve());
  HTMLVideoElement.prototype.requestFullscreen = vi.fn(() => Promise.resolve());
  
  if (!document.exitFullscreen) {
    document.exitFullscreen = vi.fn(() => Promise.resolve());
  }
  if (!document.exitPictureInPicture) {
    document.exitPictureInPicture = vi.fn(() => Promise.resolve());
  }
});

vi.mock("../src/vast.js", () => ({
  fetchVastAd: vi.fn(() => null),
  parseVastDocument: vi.fn(),
  collectVastTrackers: vi.fn(),
}));

// Mock epg.js
vi.mock("../src/epg.js", () => ({
  getEPGNow: vi.fn(() => null),
}));

// Mock utils.js for vastProxyUrl etc.
vi.mock("../src/utils.js", async () => {
  const actual = await vi.importActual("../src/utils.js");
  return {
    ...actual,
    VAST_URL: "https://ads.example.com/vast.xml",
    ENABLE_VAST: true,
  };
});

import { fetchVastAd } from "../src/vast.js";

import Player from "../src/components/Player.jsx";

describe("Player", () => {
  const defaultProps = {
    item: { id: "test-1", name: "Test Channel", url: "http://example.com/stream", type: "live" },
    channelList: [],
    epgData: null,
    onClose: vi.fn(),
    onFav: vi.fn(),
    isFav: vi.fn(() => false),
    connType: "stalker",
    t: (k) => k,
    isAdEligible: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should be defined as a function/component", () => {
    expect(Player).toBeDefined();
  });

  it("should render without crashing", () => {
    expect(() => render(<Player {...defaultProps} />)).not.toThrow();
  });
  it("should not apply resume position while a preroll ad is playing", async () => {
    vi.mocked(fetchVastAd).mockResolvedValueOnce({
      mediaUrl: "http://ads.example.com/preroll.mp4",
      mediaType: "video/mp4",
      title: "Preroll",
      duration: 5,
      skipOffset: null,
      trackers: {},
    });

    const props = {
      ...defaultProps,
      item: { ...defaultProps.item, type: "vod", position: 42 },
      isAdEligible: true,
    };

    render(<Player {...props} />);
    const video = document.querySelector("video");
    Object.defineProperty(video, "currentTime", { value: 0, writable: true, configurable: true });

    await waitFor(() => expect(vi.mocked(fetchVastAd)).toHaveBeenCalled());
    fireEvent(video, new Event("loadedmetadata"));
    expect(video.currentTime).toBe(0);

    fireEvent(video, new Event("ended"));
  });
  it("should skip resume when VOD is almost complete", () => {
    const props = {
      ...defaultProps,
      item: { ...defaultProps.item, type: "vod", position: 95 },
    };

    render(<Player {...props} />);
    const video = document.querySelector("video");
    Object.defineProperty(video, "currentTime", { value: 0, writable: true, configurable: true });
    Object.defineProperty(video, "duration", { value: 100, writable: true, configurable: true });
    Object.defineProperty(video, "seekable", {
      value: { length: 1, start: () => 0, end: () => 100 },
      configurable: true,
    });

    fireEvent(video, new Event("loadedmetadata"));
    expect(video.currentTime).toBe(0);
  });


  it("should show OSD with channel name", () => {
    render(<Player {...defaultProps} />);
    expect(screen.getByText("Test Channel", { selector: '.osd-name' })).toBeInTheDocument();
  });

  it("should call onClose when Escape key is pressed", () => {
    render(<Player {...defaultProps} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("should toggle play/pause on Space key", () => {
    render(<Player {...defaultProps} />);
    fireEvent.keyDown(document, { key: " " });
    // Video play/pause should be called
  });

  it("should toggle fullscreen on F key", () => {
    render(<Player {...defaultProps} />);
    fireEvent.keyDown(document, { key: "f" });
    // Player calls v.requestFullscreen() or document.exitFullscreen()
    const video = document.querySelector('video');
    if (document.fullscreenElement) {
      expect(document.exitFullscreen).toHaveBeenCalled();
    } else {
      expect(video.requestFullscreen).toHaveBeenCalled();
    }
  });

  it("should toggle stats overlay on S key", () => {
    render(<Player {...defaultProps} />);
    fireEvent.keyDown(document, { key: "s" });
  });

  it("should render close button and call onClose", () => {
    render(<Player {...defaultProps} />);
    const closeBtn = screen.getByRole("button", { name: /close/i });
    fireEvent.click(closeBtn);
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("should call onFav when fav button is clicked", () => {
    render(<Player {...defaultProps} />);
    const favBtn = screen.getByRole("button", { name: /fav/i });
    fireEvent.click(favBtn);
    expect(defaultProps.onFav).toHaveBeenCalled();
  });

  it("should render with channelList for prev/next navigation", () => {
    const props = {
      ...defaultProps,
      channelList: [
        { id: "ch1", name: "Channel 1", url: "http://example.com/1" },
        { id: "ch2", name: "Channel 2", url: "http://example.com/2" },
      ],
    };
    render(<Player {...props} />);
    expect(screen.getByRole("button", { name: /prev/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /next/i })).toBeInTheDocument();
  });

  it("should call onPlayCatchup when a catch-up program is clicked", async () => {
    const onPlayCatchup = vi.fn();
    const props = {
      ...defaultProps,
      item: { ...defaultProps.item, epgId: "ch1" },
      epgData: {
        "ch1": [
          { title: "Past Show", start: Date.now() - 7200000, stop: Date.now() - 3600000 }
        ]
      },
      onPlayCatchup
    };
    render(<Player {...props} />);
    
    // Open Catch-up Menu (the button with ↩️ icon)
    const catchupBtn = screen.getByTitle("Catch-up TV");
    fireEvent.click(catchupBtn);
    
    // Click on the past program
    const pastProg = screen.getByText("Past Show");
    fireEvent.click(pastProg);
    
    expect(onPlayCatchup).toHaveBeenCalledWith(expect.objectContaining({ epgId: "ch1" }), expect.objectContaining({ title: "Past Show" }));
  });

  it("should toggle play/pause on 'k' key", () => {
    render(<Player {...defaultProps} />);
    const video = document.querySelector('video');
    
    // Initial state is usually paused
    Object.defineProperty(video, 'paused', { value: true, writable: true });
    fireEvent.keyDown(window, { key: "k" });
    expect(video.play).toHaveBeenCalled();
    
    Object.defineProperty(video, 'paused', { value: false, writable: true });
    fireEvent.keyDown(window, { key: "k" });
    expect(video.pause).toHaveBeenCalled();
  });

  it("should toggle mute on 'm' key", () => {
    render(<Player {...defaultProps} />);
    const video = document.querySelector('video');
    video.muted = false;
    fireEvent.keyDown(window, { key: "m" });
    expect(video.muted).toBe(true);
    fireEvent.keyDown(window, { key: "m" });
    expect(video.muted).toBe(false);
  });

  it("should toggle PIP on 'p' key", () => {
    render(<Player {...defaultProps} />);
    const video = document.querySelector('video');
    fireEvent.keyDown(window, { key: "p" });
    expect(video.requestPictureInPicture).toHaveBeenCalled();
  });

  it("should toggle PIP on button click", () => {
    render(<Player {...defaultProps} />);
    const pipBtn = screen.getByTitle("Picture in Picture");
    fireEvent.click(pipBtn);
    expect(HTMLVideoElement.prototype.requestPictureInPicture).toHaveBeenCalled();
  });

  it("should toggle stats on button click", () => {
    render(<Player {...defaultProps} />);
    const statsBtn = screen.getByTitle("Stream Stats");
    fireEvent.click(statsBtn);
    expect(screen.getByText("Stream Stats")).toBeInTheDocument();
    fireEvent.click(statsBtn);
    expect(screen.queryByText("Stream Stats")).not.toBeInTheDocument();
  });

  it("should seek forward/backward on ArrowRight/ArrowLeft for VOD", () => {
    const props = { ...defaultProps, item: { ...defaultProps.item, type: "vod" } };
    render(<Player {...props} />);
    const video = document.querySelector('video');
    Object.defineProperty(video, 'duration', { value: 200, writable: true });
    video.currentTime = 100;
    
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(video.currentTime).toBe(110);
    
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(video.currentTime).toBe(100);
  });

  it("should change volume on ArrowUp/ArrowDown for VOD", () => {
    const props = { ...defaultProps, item: { ...defaultProps.item, type: "vod" } };
    render(<Player {...props} />);
    const video = document.querySelector('video');
    video.volume = 0.5;
    
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(video.volume).toBeCloseTo(0.6);
    
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(video.volume).toBeCloseTo(0.5);
  });

  it("should handle video error events", () => {
    render(<Player {...defaultProps} />);
    const video = document.querySelector('video');
    
    // Mock video error
    fireEvent.error(video);
    
    expect(screen.getByText(/Playback Error/i)).toBeInTheDocument();
  });

  it("should change channel on ArrowRight/ArrowLeft for live TV", () => {
    const props = {
      ...defaultProps,
      channelList: [
        { id: "ch1", name: "Channel 1", url: "http://example.com/1", type: "live" },
        { id: "ch2", name: "Channel 2", url: "http://example.com/2", type: "live" },
      ],
    };
    render(<Player {...props} />);
    
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByText("Channel 2", { selector: '.osd-name' })).toBeInTheDocument();
    
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByText("Channel 1", { selector: '.osd-name' })).toBeInTheDocument();
  });
});
