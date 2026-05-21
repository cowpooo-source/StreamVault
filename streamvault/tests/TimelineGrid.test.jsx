import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";

vi.mock("../src/utils.js", async () => {
  const actual = await vi.importActual("../src/utils.js");
  return {
    ...actual,
    imgSrc: vi.fn((url) => url || null),
  };
});

vi.mock("../src/epg.js", async () => {
  const actual = await vi.importActual("../src/epg.js");
  return {
    ...actual,
  };
});

let TimelineGrid;
beforeEach(async () => {
  vi.resetModules();
  TimelineGrid = (await import("../src/components/TimelineGrid.jsx")).default;
});

describe("TimelineGrid", () => {
  const sampleChannels = [
    { id: "ch1", name: "Channel 1", logo: "http://example.com/logo1.png", epgId: "epg1" },
    { id: "ch2", name: "Channel 2", logo: null, epgId: "epg2" },
  ];

  it("should render with empty channels", () => {
    render(<TimelineGrid channels={[]} epgData={{}} onPlay={vi.fn()} onPlayCatchup={vi.fn()} />);
    expect(screen.queryByText("Channel 1")).not.toBeInTheDocument();
  });

  it("should render channels with names", () => {
    render(<TimelineGrid channels={sampleChannels} epgData={{}} onPlay={vi.fn()} onPlayCatchup={vi.fn()} />);
    expect(screen.getByText("Channel 1")).toBeInTheDocument();
    expect(screen.getByText("Channel 2")).toBeInTheDocument();
  });

  it("should call onPlay when channel is clicked", () => {
    const onPlay = vi.fn();
    render(<TimelineGrid channels={sampleChannels} epgData={{}} onPlay={onPlay} onPlayCatchup={vi.fn()} />);
    fireEvent.click(screen.getByText("Channel 1"));
    expect(onPlay).toHaveBeenCalledWith(sampleChannels[0]);
  });

  it("should render time labels", () => {
    render(<TimelineGrid channels={sampleChannels} epgData={{}} onPlay={vi.fn()} onPlayCatchup={vi.fn()} />);
    const timeLabels = document.querySelectorAll(".epg-time-label");
    expect(timeLabels.length).toBeGreaterThan(0);
  });

  it("should render with EPG data and program blocks", () => {
    const epgData = {
      epg1: [
        { start: Date.now() - 1800000, stop: Date.now() + 1800000, title: "Test Program" },
      ],
    };
    const { container } = render(<TimelineGrid channels={[sampleChannels[0]]} epgData={epgData} onPlay={vi.fn()} onPlayCatchup={vi.fn()} />);
    expect(container.querySelector(".epg-prog-block")).toBeInTheDocument();
  });

  it("should call onPlayCatchup when past program is clicked", () => {
    vi.useFakeTimers();
    const onPlayCatchup = vi.fn();
    const onPlay = vi.fn();
    const pastProgram = { start: Date.now() - 3600000, stop: Date.now() - 1800000, title: "Past Program" };
    const epgData = { epg1: [pastProgram] };
    const { container } = render(
      <TimelineGrid channels={[sampleChannels[0]]} epgData={epgData} onPlay={onPlay} onPlayCatchup={onPlayCatchup} />
    );
    const progBlock = container.querySelector(".epg-prog-block");
    expect(progBlock).toBeInTheDocument();
    // Click the block — delegated through epg-prog-area
    fireEvent.click(progBlock);
    expect(onPlayCatchup).toHaveBeenCalledOnce();
    const [ch, p] = onPlayCatchup.mock.calls[0];
    expect(ch).toEqual(sampleChannels[0]);
    expect(p.title).toBe("Past Program");
    vi.useRealTimers();
  });
});