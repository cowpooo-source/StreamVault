import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { XtreamForm } from "../../../src/components/setup/XtreamForm.jsx";

describe("XtreamForm", () => {
  const defaultProps = {
    form: { server: "", user: "", pass: "" },
    setForm: vi.fn(),
    loading: false,
    err: "",
    onSubmit: vi.fn(),
  };

  it("should render server input", () => {
    render(<XtreamForm {...defaultProps} />);
    expect(screen.getByPlaceholderText("http://server.com:8080")).toBeInTheDocument();
  });

  it("should render user input", () => {
    render(<XtreamForm {...defaultProps} />);
    expect(screen.getByPlaceholderText("username")).toBeInTheDocument();
  });

  it("should render password input", () => {
    render(<XtreamForm {...defaultProps} />);
    expect(screen.getByPlaceholderText("password")).toBeInTheDocument();
  });

  it("should call setForm when server input changes", () => {
    render(<XtreamForm {...defaultProps} />);
    fireEvent.change(screen.getByPlaceholderText("http://server.com:8080"), { target: { value: "http://test.com" } });
    expect(defaultProps.setForm).toHaveBeenCalledWith("server", "http://test.com");
  });

  it("should call setForm when user input changes", () => {
    render(<XtreamForm {...defaultProps} />);
    fireEvent.change(screen.getByPlaceholderText("username"), { target: { value: "myuser" } });
    expect(defaultProps.setForm).toHaveBeenCalledWith("user", "myuser");
  });

  it("should call setForm when password input changes", () => {
    render(<XtreamForm {...defaultProps} />);
    fireEvent.change(screen.getByPlaceholderText("password"), { target: { value: "mypass" } });
    expect(defaultProps.setForm).toHaveBeenCalledWith("pass", "mypass");
  });

  it("should submit on Enter in password field", () => {
    render(<XtreamForm {...defaultProps} />);
    fireEvent.keyDown(screen.getByPlaceholderText("password"), { key: "Enter" });
    expect(defaultProps.onSubmit).toHaveBeenCalled();
  });
});