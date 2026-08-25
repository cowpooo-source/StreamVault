import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { ConnectionManagerList } from "../../../src/components/setup/ConnectionManagerList.jsx";

const mockConfirm = vi.fn(() => false);
globalThis.confirm = mockConfirm;

describe("ConnectionManagerList", () => {
  const defaultProps = {
    connections: [],
    activeConnId: null,
    diagResults: {},
    diagLoading: {},
    onReconnect: vi.fn(),
    onEdit: vi.fn(),
    onRemoveConn: vi.fn(),
    onDiagnose: vi.fn(),
  };

  beforeEach(() => mockConfirm.mockClear());

  it("should render nothing when connections is empty", () => {
    render(<ConnectionManagerList {...defaultProps} />);
    expect(screen.queryByText(/saved/i)).not.toBeInTheDocument();
  });

  it("should render saved connections with diagnose button", () => {
    const connections = [{ id: "1", label: "Test Conn", type: "stalker", color: "#ff6600" }];
    render(<ConnectionManagerList {...defaultProps} connections={connections} />);
    expect(screen.getByText("Test Conn")).toBeInTheDocument();
    expect(screen.getByTitle("Diagnose connection")).toBeInTheDocument();
  });

  it("should call onDiagnose when diagnose button is clicked", () => {
    const connections = [{ id: "1", label: "Test", type: "xtream" }];
    render(<ConnectionManagerList {...defaultProps} connections={connections} />);
    fireEvent.click(screen.getByTitle("Diagnose connection"));
    expect(defaultProps.onDiagnose).toHaveBeenCalledWith(connections[0]);
  });

  it("should show loading dots when diagLoading", () => {
    const connections = [{ id: "1", label: "Test", type: "xtream" }];
    const props = { ...defaultProps, connections, diagLoading: { "1": true } };
    render(<ConnectionManagerList {...props} />);
    expect(screen.getByText("...")).toBeInTheDocument();
  });

  it("should display reachable diag result", () => {
    const connections = [{ id: "1", label: "Test", type: "xtream" }];
    const props = {
      ...defaultProps,
      connections,
      diagResults: {
        "1": { reachable: true, latency: 120, details: {} },
      },
    };
    render(<ConnectionManagerList {...props} />);
    expect(screen.getByText(/reachable/i)).toBeInTheDocument();
    expect(screen.getByText(/120ms/i)).toBeInTheDocument();
  });

  it("should display unreachable diag result with error", () => {
    const connections = [{ id: "1", label: "Test", type: "xtream" }];
    const props = {
      ...defaultProps,
      connections,
      diagResults: {
        "1": { reachable: false, latency: null, details: { error: "Connection refused" } },
      },
    };
    render(<ConnectionManagerList {...props} />);
    expect(screen.getByText(/unreachable/i)).toBeInTheDocument();
    expect(screen.getByText(/connection refused/i)).toBeInTheDocument();
  });

  it("should call onEdit when edit button is clicked", () => {
    const connections = [{ id: "1", label: "Test", type: "xtream" }];
    render(<ConnectionManagerList {...defaultProps} connections={connections} />);
    fireEvent.click(screen.getByTitle("Edit connection"));
    expect(defaultProps.onEdit).toHaveBeenCalledWith(connections[0]);
  });

  it("should call confirm before onRemoveConn", () => {
    const connections = [{ id: "1", label: "Test", type: "xtream" }];
    render(<ConnectionManagerList {...defaultProps} connections={connections} />);
    fireEvent.click(screen.getByTitle("Delete connection"));
    expect(mockConfirm).toHaveBeenCalled();
  });
});