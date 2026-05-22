import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import SettingsView from "../src/components/SettingsView.jsx";
import { db } from "../src/app-runtime.js";

vi.mock("../src/app-runtime.js", () => ({
  db: { get: vi.fn(async (_key, fallback) => fallback) }
}));

describe("SettingsView", () => {
  const defaultProps = {
    connections: [],
    authUser: null,
    activeConnId: null,
    onAuth: vi.fn(),
    onImportFull: vi.fn(),
    autoLoadMore: false,
    setAutoLoadMore: vi.fn()
  };

  it("should render General tab by default", () => {
    render(<SettingsView {...defaultProps} />);
    expect(screen.getByText("Playback & Content")).toBeInTheDocument();
  });

  it("should switch to Account tab", () => {
    render(<SettingsView {...defaultProps} />);
    fireEvent.click(screen.getByText("Account"));
    expect(screen.getByText("Profile")).toBeInTheDocument();
  });

  it("should switch to Data tab", () => {
    render(<SettingsView {...defaultProps} />);
    fireEvent.click(screen.getByText("Data"));
    expect(screen.getByText("Export Data")).toBeInTheDocument();
  });

  it("should read export data from the db prop", () => {
    render(<SettingsView {...defaultProps} />);
    fireEvent.click(screen.getByText("Data"));
    fireEvent.click(screen.getByText("Download Backup (.json)"));
    expect(db.get).toHaveBeenCalledWith("sv-connections", []);
  });
});