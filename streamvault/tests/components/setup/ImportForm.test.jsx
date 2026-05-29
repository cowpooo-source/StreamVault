import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { ImportForm } from "../../../src/components/setup/ImportForm.jsx";

describe("ImportForm", () => {
  const defaultProps = {
    onImportMultiple: vi.fn(),
    setRawText: vi.fn(),
    detected: [],
    t: k => k
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should handle raw text input", () => {
    // Pass detected prop manually since the parent normally handles it
    render(<ImportForm {...defaultProps} detected={[{ type: "m3u", name: "Imported M3U 1", url: "http://example.com/ch1" }]} onFillSingle={vi.fn()} />);
    
    expect(screen.getByText("Detected (1)")).toBeInTheDocument();

    const fillBtn = screen.getByText("Click to fill");
    fireEvent.click(fillBtn);
  });

  it("should show error on invalid text input", () => {
    render(<ImportForm {...defaultProps} rawText="invalid text" detected={[]} />);
    expect(screen.getByText("No connections detected")).toBeInTheDocument();
  });
});