import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { JellyfinConnectStep } from "../../../src/components/setup/JellyfinConnectStep.jsx";
import { JellyfinAdapter } from "../../../src/adapters/jellyfin-adapter.js";

vi.mock("../../../src/adapters/jellyfin-adapter.js", () => ({
  JellyfinAdapter: {
    authenticate: vi.fn(),
  },
}));

describe("JellyfinConnectStep", () => {
  const defaultProps = {
    onConnected: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      })
    );
  });

  it("should render server URL input", () => {
    render(<JellyfinConnectStep {...defaultProps} />);
    expect(screen.getByPlaceholderText("https://jellyfin.example.com")).toBeInTheDocument();
  });

  it("should render username input", () => {
    render(<JellyfinConnectStep {...defaultProps} />);
    expect(screen.getByPlaceholderText("Username")).toBeInTheDocument();
  });

  it("should render password input", () => {
    render(<JellyfinConnectStep {...defaultProps} />);
    expect(screen.getByPlaceholderText("Password")).toBeInTheDocument();
  });

  it("should call authenticate on submit", async () => {
    JellyfinAdapter.authenticate.mockResolvedValueOnce({ accessToken: "token123", userId: "user123" });
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}),
    });

    render(<JellyfinConnectStep {...defaultProps} />);

    fireEvent.change(screen.getByPlaceholderText("https://jellyfin.example.com"), { target: { value: "https://jellyfin.example.com" } });
    fireEvent.change(screen.getByPlaceholderText("Username"), { target: { value: "testuser" } });
    fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "testpass" } });

    fireEvent.click(screen.getByText("Connect"));

    await vi.waitFor(() => {
      expect(JellyfinAdapter.authenticate).toHaveBeenCalledWith("https://jellyfin.example.com", "testuser", "testpass");
    });
  });

  it("should show error on auth failure", async () => {
    JellyfinAdapter.authenticate.mockRejectedValueOnce(new Error("Invalid credentials"));

    render(<JellyfinConnectStep {...defaultProps} />);

    fireEvent.change(screen.getByPlaceholderText("https://jellyfin.example.com"), { target: { value: "https://jellyfin.example.com" } });
    fireEvent.change(screen.getByPlaceholderText("Username"), { target: { value: "baduser" } });
    fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "badpass" } });

    fireEvent.click(screen.getByText("Connect"));

    await vi.waitFor(() => {
      expect(screen.getByText("Invalid credentials")).toBeInTheDocument();
    });
    expect(defaultProps.onConnected).not.toHaveBeenCalled();
  });

  it("should show error on save failure", async () => {
    JellyfinAdapter.authenticate.mockResolvedValueOnce({ accessToken: "token123", userId: "user123" });
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: "Server connection failed" }),
    });

    render(<JellyfinConnectStep {...defaultProps} />);

    fireEvent.change(screen.getByPlaceholderText("https://jellyfin.example.com"), { target: { value: "https://jellyfin.example.com" } });
    fireEvent.change(screen.getByPlaceholderText("Username"), { target: { value: "testuser" } });
    fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "testpass" } });

    fireEvent.click(screen.getByText("Connect"));

    await vi.waitFor(() => {
      expect(screen.getByText("Server connection failed")).toBeInTheDocument();
    });
    expect(defaultProps.onConnected).not.toHaveBeenCalled();
  });

  it("should show generic error when save response is not JSON", async () => {
    JellyfinAdapter.authenticate.mockResolvedValueOnce({ accessToken: "token123", userId: "user123" });
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error("Not JSON")),
      text: () => Promise.resolve("Internal Server Error"),
    });

    render(<JellyfinConnectStep {...defaultProps} />);

    fireEvent.change(screen.getByPlaceholderText("https://jellyfin.example.com"), { target: { value: "https://jellyfin.example.com" } });
    fireEvent.change(screen.getByPlaceholderText("Username"), { target: { value: "testuser" } });
    fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "testpass" } });

    fireEvent.click(screen.getByText("Connect"));

    await vi.waitFor(() => {
      expect(screen.getByText("Failed to save server")).toBeInTheDocument();
    });
  });
});
