import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { StalkerForm } from "../../../src/components/setup/StalkerForm.jsx";

describe("StalkerForm", () => {
  const defaultProps = {
    form: { server: "", mac: "", serial: "", deviceId: "", deviceId2: "" },
    setForm: vi.fn(),
    loading: false,
    err: "",
    skipValidation: false,
    setSkipValidation: vi.fn(),
    onSubmit: vi.fn(),
    onValidate: vi.fn(),
  };

  it("should render portal URL input", () => {
    render(<StalkerForm {...defaultProps} />);
    expect(screen.getByPlaceholderText("http://server/stalker_portal/c/")).toBeInTheDocument();
  });

  it("should render MAC address input", () => {
    render(<StalkerForm {...defaultProps} />);
    expect(screen.getByPlaceholderText("00:1A:79:XX:XX:XX")).toBeInTheDocument();
  });

  it("should render skip validation checkbox", () => {
    render(<StalkerForm {...defaultProps} />);
    expect(screen.getByRole("checkbox")).toBeInTheDocument();
  });

  it("should call setSkipValidation when checkbox changes", () => {
    render(<StalkerForm {...defaultProps} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(defaultProps.setSkipValidation).toHaveBeenCalled();
  });

  it("should show advanced options toggle button", () => {
    render(<StalkerForm {...defaultProps} />);
    expect(screen.getByText(/advanced/i)).toBeInTheDocument();
  });

  it("should hide advanced fields by default", () => {
    render(<StalkerForm {...defaultProps} />);
    expect(screen.queryByPlaceholderText("Optional — leave blank for auto")).not.toBeInTheDocument();
  });

  it("should show advanced fields when toggle is clicked", () => {
    render(<StalkerForm {...defaultProps} />);
    fireEvent.click(screen.getByText(/advanced options/i));
    expect(screen.getByPlaceholderText("Optional — leave blank for auto")).toBeInTheDocument();
  });

  it("should call setForm when portal URL changes", () => {
    render(<StalkerForm {...defaultProps} />);
    fireEvent.change(screen.getByPlaceholderText("http://server/stalker_portal/c/"), { target: { value: "http://myserver" } });
    expect(defaultProps.setForm).toHaveBeenCalledWith("server", "http://myserver");
  });

  it("should call setForm when MAC changes", () => {
    render(<StalkerForm {...defaultProps} />);
    fireEvent.change(screen.getByPlaceholderText("00:1A:79:XX:XX:XX"), { target: { value: "00:1A:79:AA:BB:CC" } });
    expect(defaultProps.setForm).toHaveBeenCalledWith("mac", "00:1A:79:AA:BB:CC");
  });

  it("should submit on Enter in Device ID 2 field", () => {
    render(<StalkerForm {...defaultProps} />);
    fireEvent.click(screen.getByText(/advanced options/i));
    fireEvent.keyDown(screen.getByPlaceholderText("Optional — defaults to Device ID above"), { key: "Enter" });
    expect(defaultProps.onSubmit).toHaveBeenCalled();
  });
});