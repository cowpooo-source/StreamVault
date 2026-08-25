import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { ConnectionList } from "../../../src/components/setup/ConnectionList.jsx";

// Mock window.confirm for delete button tests
const mockConfirm = vi.fn(() => false);
globalThis.confirm = mockConfirm;

describe("ConnectionList", () => {
  const defaultProps = {
    connections: [],
    activeConnId: null,
    onReconnect: vi.fn(),
    onEdit: vi.fn(),
    onRemoveConn: vi.fn(),
  };

  beforeEach(() => mockConfirm.mockClear());

  it("should render nothing when connections is empty", () => {
    render(<ConnectionList {...defaultProps} />);
    expect(screen.queryByText(/saved/i)).not.toBeInTheDocument();
  });

  it("should render saved connections", () => {
    const connections = [
      { id: "1", label: "My Xtream", type: "xtream", color: "#00d4ff" },
      { id: "2", label: "My Stalker", type: "stalker", color: "#ff6600" },
    ];
    render(<ConnectionList {...defaultProps} connections={connections} />);
    expect(screen.getByText("My Xtream")).toBeInTheDocument();
    expect(screen.getByText("My Stalker")).toBeInTheDocument();
  });

  it("should show connection type labels", () => {
    const connections = [{ id: "1", label: "Test", type: "xtream" }];
    render(<ConnectionList {...defaultProps} connections={connections} />);
    expect(screen.getByText("xtream")).toBeInTheDocument();
  });

  it("should call onEdit when edit button is clicked", () => {
    const connections = [{ id: "1", label: "Test", type: "xtream" }];
    render(<ConnectionList {...defaultProps} connections={connections} />);
    fireEvent.click(screen.getByTitle("Edit connection"));
    expect(defaultProps.onEdit).toHaveBeenCalledWith(connections[0]);
  });

  it("should call window.confirm before onRemoveConn", () => {
    const connections = [{ id: "1", label: "Test", type: "xtream" }];
    render(<ConnectionList {...defaultProps} connections={connections} />);
    fireEvent.click(screen.getByTitle("Delete connection"));
    expect(mockConfirm).toHaveBeenCalled();
  });
});