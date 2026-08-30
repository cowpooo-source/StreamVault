import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import Setup from "../src/components/Setup.jsx";

// Mock sub-components
vi.mock("../src/components/setup/XtreamForm.jsx", () => ({ XtreamForm: () => <div data-testid="xtream-form" /> }));
vi.mock("../src/components/setup/M3UForm.jsx", () => ({ M3UForm: ({ onFileImport, onImportMultiple }) => (
  <div data-testid="m3u-form">
    <button type="button" onClick={() => onFileImport?.({ target: { files: [new File(["{}"], "backup.json")], value: "" } })}>
      trigger m3u file import
    </button>
    <button type="button" onClick={() => onImportMultiple?.([{ type: "m3u", url: "http://example.test/list.m3u" }])}>
      trigger m3u multi import
    </button>
  </div>
) }));
vi.mock("../src/components/setup/StalkerForm.jsx", () => ({ StalkerForm: () => <div data-testid="stalker-form" /> }));
vi.mock("../src/components/setup/ImportForm.jsx", () => ({ ImportForm: ({ onFileImport, onImportMultiple }) => (
  <div data-testid="import-form">
    <button type="button" onClick={() => onFileImport?.({ target: { files: [new File(["{}"], "backup.json")], value: "" } })}>
      trigger import file
    </button>
    <button type="button" onClick={() => onImportMultiple?.([{ type: "m3u", url: "http://example.test/list.m3u" }])}>
      trigger import multi
    </button>
  </div>
) }));
vi.mock("../src/components/setup/ConnectionManagerList.jsx", () => ({ ConnectionManagerList: () => <div data-testid="conn-manager-list" /> }));

globalThis.API = "http://localhost";

describe("Setup", () => {
  const defaultProps = {
    onConnect: vi.fn(), onImportMultiple: vi.fn(), onImportFull: vi.fn(),
    connections: [], onReconnect: vi.fn(), onRemoveConn: vi.fn(),
    onEdit: vi.fn(), authUser: null, isGuest: true, onLogout: vi.fn(),
    t: k => k, visible: true
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    window.alert = vi.fn();
    globalThis.FileReader = class {
      readAsText() {
        this.onload?.({ target: { result: JSON.stringify({ connections: [] }) } });
      }
    };
  });

  it("should render Xtream tab by default when there are no connections", () => {
    render(<Setup {...defaultProps} />);
    expect(screen.getByTestId("xtream-form")).toBeInTheDocument();
  });

  it("should switch to M3U tab", () => {
    render(<Setup {...defaultProps} />);
    fireEvent.click(screen.getByText("m3uPlaylist"));
    expect(screen.getByTestId("m3u-form")).toBeInTheDocument();
  });

  it("should switch to Stalker tab", () => {
    render(<Setup {...defaultProps} />);
    fireEvent.click(screen.getByText("stalkerPortal"));
    expect(screen.getByTestId("stalker-form")).toBeInTheDocument();
  });

  it("should switch to Import tab", () => {
    render(<Setup {...defaultProps} />);
    fireEvent.click(screen.getByText("import"));
    expect(screen.getByTestId("import-form")).toBeInTheDocument();
  });

  it("requires disclaimer acceptance before importing a backup file", async () => {
    render(<Setup {...defaultProps} />);
    fireEvent.click(screen.getByText("import"));
    fireEvent.click(screen.getByRole("button", { name: "trigger import file" }));

    expect(defaultProps.onImportFull).not.toHaveBeenCalled();
    expect(screen.getByText("Legal Disclaimer")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /I Agree/ }));
    await waitFor(() => expect(defaultProps.onImportFull).toHaveBeenCalledTimes(1));
  });

  it("requires disclaimer acceptance before importing detected connections", async () => {
    render(<Setup {...defaultProps} />);
    fireEvent.click(screen.getByText("import"));
    fireEvent.click(screen.getByRole("button", { name: "trigger import multi" }));

    expect(defaultProps.onImportMultiple).not.toHaveBeenCalled();
    expect(screen.getByText("Legal Disclaimer")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /I Agree/ }));
    await waitFor(() => expect(defaultProps.onImportMultiple).toHaveBeenCalledWith([
      { type: "m3u", url: "http://example.test/list.m3u" },
    ]));
  });

  it("gates backup imports opened from Settings", async () => {
    render(<Setup {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    fireEvent.click(screen.getByRole("tab", { name: "Data" }));
    fireEvent.change(document.querySelector('input[type="file"]'), {
      target: { files: [new File(["{}"], "settings-backup.json")] },
    });

    expect(defaultProps.onImportFull).not.toHaveBeenCalled();
    expect(screen.getByText("Legal Disclaimer")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /I Agree/ }));
    await waitFor(() => expect(defaultProps.onImportFull).toHaveBeenCalledTimes(1));
  });

  it("should render Manage tab by default if connections exist", () => {
    render(<Setup {...defaultProps} connections={[{id: "1", type: "m3u"}]} />);
    expect(screen.getByTestId("conn-manager-list")).toBeInTheDocument();
  });

  it("opens settings from the profile card", () => {
    render(<Setup {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByText("Playback & Content")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("opens billing from Setup settings", () => {
    const onOpenAccountSettings = vi.fn();
    render(<Setup {...defaultProps} onOpenAccountSettings={onOpenAccountSettings} />);

    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    fireEvent.click(screen.getByRole("tab", { name: "Account" }));
    fireEvent.click(screen.getByRole("button", { name: /billing & plans/i }));

    expect(onOpenAccountSettings).toHaveBeenCalledWith("billing");
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
  });
});
