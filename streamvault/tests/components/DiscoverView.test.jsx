import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import DiscoverView from "../../src/components/DiscoverView.jsx";

// Mock the utils and fetch
global.API = "http://localhost";
global.fetch = vi.fn();

vi.mock("../../src/utils.js", () => ({
  imgSrc: vi.fn(u => u),
  API: "http://localhost"
}));

vi.mock("../../src/app-runtime.js", () => ({
  safeJsonFetch: async (res) => {
    if (!res.ok) throw new Error("HTTP fail");
    return JSON.parse(await res.text());
  }
}));

describe("DiscoverView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const defaultProps = {
    tmdbKey: "test-key",
    setTmdbKey: vi.fn(),
    vod: [{ id: "v1", name: "The Matrix", group: "Action", logo: "mat.jpg" }],
    series: [{ id: "s1", name: "Breaking Bad", group: "Drama", logo: "bb.jpg" }],
    onPlay: vi.fn(),
    t: (k) => k
  };

  it("should render API key prompt if no key", () => {
    render(<DiscoverView {...defaultProps} tmdbKey="" />);
    expect(screen.getByText("Discover Trending Content")).toBeInTheDocument();
  });

  it("should save API key when submitted", () => {
    render(<DiscoverView {...defaultProps} tmdbKey="" />);
    const input = screen.getByPlaceholderText(/Paste TMDB v3 API key/i);
    fireEvent.change(input, { target: { value: "new-key" } });
    fireEvent.click(screen.getByText("Go"));
    expect(defaultProps.setTmdbKey).toHaveBeenCalledWith("new-key");
  });

  it("should clear API key", () => {
    render(<DiscoverView {...defaultProps} />);
    fireEvent.click(screen.getByText("Change API Key"));
    expect(defaultProps.setTmdbKey).toHaveBeenCalledWith("");
  });

  it("should fetch and render trending movies and tv", async () => {
    global.fetch.mockResolvedValue({
      ok: true, text: async () => JSON.stringify({ results: [{ id: 1, title: "Trending Movie", poster_path: "/img.jpg" }, { id: 2, name: "Trending TV", poster_path: "/tv.jpg" }] })
    });

    render(<DiscoverView {...defaultProps} />);
    
    // Wait for the fetch to resolve and state to update
    await waitFor(() => {
      expect(screen.getAllByText("Trending Movie").length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText("Trending TV").length).toBeGreaterThan(0);
  });

  it("should handle fetch errors gracefully", async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 500, text: async () => "error" });
    render(<DiscoverView {...defaultProps} />);
    
    await waitFor(() => {
      expect(defaultProps.setTmdbKey).toHaveBeenCalledWith("");
    });
  });

  it("should open details picker or play directly when an item is clicked", async () => {
    global.fetch.mockResolvedValue({
      ok: true, text: async () => JSON.stringify({ results: [{ id: 1, title: "The Matrix", poster_path: "/img.jpg", overview: "Neo" }] })
    });

    render(<DiscoverView {...defaultProps} />);
    
    await waitFor(() => {
      expect(screen.getAllByText("The Matrix").length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getAllByText("The Matrix")[0]);
    
    // Since there is exactly 1 match in the library, it should call onPlay directly
    expect(defaultProps.onPlay).toHaveBeenCalledWith(defaultProps.vod[0]);
  });
});