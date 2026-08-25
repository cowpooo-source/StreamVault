import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

let DiscoverView;
beforeEach(async () => {
  vi.resetModules();
  DiscoverView = (await import("../src/components/DiscoverView.jsx")).default;
});

vi.mock("../src/utils.js", async () => {
  const actual = await vi.importActual("../src/utils.js");
  return {
    ...actual,
    imgSrc: vi.fn(u => u),
    API: "http://localhost",
  };
});

vi.mock("../src/app-runtime.js", async () => {
  const actual = await vi.importActual("../src/app-runtime.js");
  return {
    ...actual,
    safeJsonFetch: vi.fn(),
  };
});

describe("DiscoverView", () => {
  it("should render API key prompt if no key", async () => {
    const Discovered = await import("../src/components/DiscoverView.jsx");
    DiscoverView = Discovered.default;
    render(<DiscoverView tmdbKey="" setTmdbKey={vi.fn()} vod={[]} series={[]} onPlay={vi.fn()} />);
    expect(screen.getByText("Discover Trending Content")).toBeInTheDocument();
  });

  it("should export a component usable with explicit props", async () => {
    expect(DiscoverView).toBeDefined();
  });
});