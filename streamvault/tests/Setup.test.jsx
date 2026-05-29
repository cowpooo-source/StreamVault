import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import Setup from "../src/components/Setup.jsx";

// Mock sub-components
vi.mock("../src/components/setup/XtreamForm.jsx", () => ({ XtreamForm: () => <div data-testid="xtream-form" /> }));
vi.mock("../src/components/setup/M3UForm.jsx", () => ({ M3UForm: () => <div data-testid="m3u-form" /> }));
vi.mock("../src/components/setup/StalkerForm.jsx", () => ({ StalkerForm: () => <div data-testid="stalker-form" /> }));
vi.mock("../src/components/setup/ImportForm.jsx", () => ({ ImportForm: () => <div data-testid="import-form" /> }));
vi.mock("../src/components/setup/ConnectionManagerList.jsx", () => ({ ConnectionManagerList: () => <div data-testid="conn-manager-list" /> }));

global.API = "http://localhost";

describe("Setup", () => {
  const defaultProps = {
    onConnect: vi.fn(), onImportMultiple: vi.fn(), onImportFull: vi.fn(),
    connections: [], onReconnect: vi.fn(), onRemoveConn: vi.fn(),
    onEdit: vi.fn(), authUser: null, isGuest: true, onLogout: vi.fn(),
    t: k => k, visible: true
  };

  beforeEach(() => {
    vi.clearAllMocks();
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

  it("should render Manage tab by default if connections exist", () => {
    render(<Setup {...defaultProps} connections={[{id: "1", type: "m3u"}]} />);
    expect(screen.getByTestId("conn-manager-list")).toBeInTheDocument();
  });
});