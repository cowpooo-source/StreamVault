import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import "@testing-library/jest-dom/vitest";
import DirectHLSView from "../src/components/DirectHLSView.jsx";

// Mock Player
vi.mock("../src/components/Player.jsx", () => ({
  default: () => <div data-testid="mock-player">Player</div>
}));

describe("DirectHLSView", () => {
  it("should render input and examples", () => {
    render(<DirectHLSView />);
    expect(screen.getByPlaceholderText(/https:\/\/your-stream.com/i)).toBeInTheDocument();
    expect(screen.getByText("Public test streams")).toBeInTheDocument();
  });
});
