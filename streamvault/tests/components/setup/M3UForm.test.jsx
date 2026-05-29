import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { M3UForm } from "../../../src/components/setup/M3UForm.jsx";

describe("M3UForm", () => {
  const defaultProps = {
    form: { url: "" },
    setForm: vi.fn(),
    rawText: "",
    setRawText: vi.fn(),
    loading: false,
    err: "",
    detected: [],
    selected: new Set(),
    setSelected: vi.fn(),
    onSubmit: vi.fn(),
    onFileImport: vi.fn(),
    onDetect: vi.fn(),
  };

  it("should render playlist URL input", () => {
    render(<M3UForm {...defaultProps} />);
    expect(screen.getByPlaceholderText("http://example.com/playlist.m3u")).toBeInTheDocument();
  });

  it("should render paste raw textarea", () => {
    render(<M3UForm {...defaultProps} />);
    expect(screen.getByPlaceholderText(/paste any text/i)).toBeInTheDocument();
  });

  it("should render 'Import from Backup File' label", () => {
    render(<M3UForm {...defaultProps} />);
    expect(screen.getByText("Import from Backup File")).toBeInTheDocument();
  });

  it("should call setForm when URL changes", () => {
    render(<M3UForm {...defaultProps} />);
    fireEvent.change(screen.getByPlaceholderText("http://example.com/playlist.m3u"), { target: { value: "http://test.m3u" } });
    expect(defaultProps.setForm).toHaveBeenCalledWith("url", "http://test.m3u");
  });

  it("should call onDetect when raw text changes", () => {
    render(<M3UForm {...defaultProps} />);
    fireEvent.change(screen.getByPlaceholderText(/paste any text/i), { target: { value: "http://test.com" } });
    expect(defaultProps.onDetect).toHaveBeenCalledWith("http://test.com");
  });

  it("should show detected connections when provided", () => {
    const props = {
      ...defaultProps,
      rawText: "some text",
      detected: [
        { type: "stalker", label: "Stalker · AA:BB:CC", mac: "AA:BB:CC", server: "" },
      ],
    };
    render(<M3UForm {...props} />);
    expect(screen.getByText("Detected (1)")).toBeInTheDocument();
  });

  it("should show no-connections message when text is provided but nothing detected", () => {
    const props = { ...defaultProps, rawText: "unrelated text" };
    render(<M3UForm {...props} />);
    expect(screen.getByText(/no connections/i)).toBeInTheDocument();
  });
});