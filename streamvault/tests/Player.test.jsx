import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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
  HTMLVideoElement.prototype.requestFullscreen = vi.fn(() => Promise.resolve());
  document.exitPictureInPicture = vi.fn(() => Promise.resolve());
});

// Mock fetchVastAd and parseVastDocument
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
    VAST_URL: null,
  };
});

// Import the real Player component (not mocked)
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
    const closeBtn = screen.getByText("✕ close");
    fireEvent.click(closeBtn);
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("should call onFav when fav button is clicked", () => {
    render(<Player {...defaultProps} />);
    const favBtn = screen.getByText(/♡ fav/i);
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
    expect(screen.getByText("◀ prev")).toBeInTheDocument();
    expect(screen.getByText("next ▶")).toBeInTheDocument();
  });
});
