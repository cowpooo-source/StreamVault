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

  it("shows social account links in the Account tab for signed-in users", () => {
    render(<SettingsView {...defaultProps} authUser={{ username: "cow", role: "regular" }} />);
    fireEvent.click(screen.getByText("Account"));
    expect(screen.getByRole("button", { name: "Link Google" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Link GitHub" })).toBeInTheDocument();
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

  it("redirects backup management to the secure app in HTTP content mode", () => {
    const onOpenSecureSettings = vi.fn();
    render(<SettingsView {...defaultProps} contentMode onOpenSecureSettings={onOpenSecureSettings} />);
    fireEvent.click(screen.getByText("Data"));
    expect(screen.queryByText("Download Backup (.json)")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Manage Backups Securely"));
    expect(onOpenSecureSettings).toHaveBeenCalledOnce();
  });

  it("exposes appearance, account actions, and connection allowance", () => {
    const onThemeChange = vi.fn();
    const onLanguageChange = vi.fn();
    const onFeedback = vi.fn();
    render(<SettingsView {...defaultProps}
      connections={[{ id: "one", label: "One" }]}
      themeName="Dark" themeOptions={["Dark", "Light"]} onThemeChange={onThemeChange}
      language="en" languageOptions={{ en: "English", fr: "French" }} onLanguageChange={onLanguageChange}
      onFeedback={onFeedback} maxConnections={2} />);
    fireEvent.change(screen.getByLabelText("Theme"), { target: { value: "Light" } });
    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "fr" } });
    fireEvent.click(screen.getByText("Send Feedback"));
    expect(onThemeChange).toHaveBeenCalledWith("Light");
    expect(onLanguageChange).toHaveBeenCalledWith("fr");
    expect(onFeedback).toHaveBeenCalledOnce();
    expect(screen.getByText("1 / 2 saved")).toBeInTheDocument();
  });});
