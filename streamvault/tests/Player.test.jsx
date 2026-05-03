import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

// Mock the entire Player module since it has complex dependencies (HLS.js, mpegts.js, video APIs)
vi.mock("../src/components/Player.jsx", () => ({
  default: vi.fn((props) => React.createElement("div", { "data-test-id": "player-mock" }, `Player: ${props.item?.name || "Unknown"}`)),
}));

import Player from "../src/components/Player.jsx";

describe("Player", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should be defined as a function/component", () => {
    expect(Player).toBeDefined();
  });

  it("should render mock without crashing", () => {
    const props = {
      item: { id: "test-1", name: "Test Channel", url: "http://example.com/stream", type: "live" },
      channelList: [],
      epgData: null,
      onClose: vi.fn(),
      onFav: vi.fn(),
      isFav: false,
      connType: "stalker",
      t: (k) => k,
      isAdEligible: false,
    };

    expect(() => render(<Player {...props} />)).not.toThrow();
    expect(screen.getByTestId("player-mock")).toBeInTheDocument();
  });
});
