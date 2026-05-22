import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import Setup from "../src/components/Setup.jsx";

describe("Setup", () => {
  const defaultProps = {
    onConnect: vi.fn(),
    onImportMultiple: vi.fn(),
    onImportFull: vi.fn(),
    connections: [],
    onReconnect: vi.fn(),
    onRemoveConn: vi.fn(),
    onEdit: vi.fn(),
    authUser: null,
    isGuest: true,
    onLogout: vi.fn(),
    t: k => k
  };

  it("should render setup tabs", () => {
    render(<Setup {...defaultProps} />);
    expect(screen.getByText("xtreamCodes")).toBeInTheDocument();
    expect(screen.getByText("m3uPlaylist")).toBeInTheDocument();
    expect(screen.getByText("stalkerPortal")).toBeInTheDocument();
  });
});