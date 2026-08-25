import { describe, expect, it, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import React from "react";

vi.mock("../src/vast.js", () => ({ fetchVastAd: vi.fn(() => null) }));
vi.mock("../src/epg.js", () => ({ getEPGNow: vi.fn(() => null) }));
import Player from "../src/components/Player.jsx";

describe("Player audio and subtitle controls", () => {
  beforeEach(() => {
    class HlsMock {
      static Events = {
        MANIFEST_PARSED: "manifest",
        AUDIO_TRACKS_UPDATED: "audioTracks",
        SUBTITLE_TRACKS_UPDATED: "subtitleTracks",
        AUDIO_TRACK_SWITCHED: "audioSwitched",
        SUBTITLE_TRACK_SWITCH: "subtitleSwitched",
        ERROR: "error",
      };
      static ErrorTypes = {};
      static isSupported = () => true;
      constructor() {
        this.handlers = {};
        this.audioTracks = [{ name: "English", lang: "en" }, { name: "French", lang: "fr" }];
        this.subtitleTracks = [{ name: "English CC", lang: "en" }];
        this.audioTrack = 0;
        this.subtitleTrack = -1;
        window.__hls = this;
      }
      on(event, handler) { this.handlers[event] = handler; }
      loadSource() {}
      attachMedia() {}
      destroy() {}
    }
    window.Hls = HlsMock;
    window.mpegts = { isSupported: () => false, Events: {} };
    HTMLVideoElement.prototype.play = vi.fn(() => Promise.resolve());
    HTMLVideoElement.prototype.pause = vi.fn();
    HTMLVideoElement.prototype.load = vi.fn();
    HTMLVideoElement.prototype.removeAttribute = vi.fn();
  });

  it("exposes and switches HLS audio and subtitle tracks", async () => {
    render(<Player
      item={{ id: "vod-1", name: "Movie", url: "http://provider/movie/index.m3u8", type: "vod" }}
      channelList={[]}
      epgData={null}
      onClose={vi.fn()}
      onFav={vi.fn()}
      isFav={() => false}
      connType="xtream"
      t={(key) => key}
      isAdEligible={false}
    />);

    await act(async () => {
      window.__hls.handlers.manifest();
      window.__hls.handlers.audioTracks();
      window.__hls.handlers.subtitleTracks();
    });
    await waitFor(() => expect(screen.getByTitle("Audio & Subtitles")).toBeInTheDocument());
    fireEvent.click(screen.getByTitle("Audio & Subtitles"));
    expect(screen.getByText("French")).toBeInTheDocument();
    expect(screen.getByText("English CC")).toBeInTheDocument();

    fireEvent.click(screen.getByText("French"));
    fireEvent.click(screen.getByText("English CC"));
    expect(window.__hls.audioTrack).toBe(1);
    expect(window.__hls.subtitleTrack).toBe(0);
  });
});
