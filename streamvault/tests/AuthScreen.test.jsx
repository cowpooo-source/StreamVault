import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

// Mock window.turnstile
Object.defineProperty(window, 'turnstile', {
  value: { render: vi.fn(), reset: vi.fn() },
  writable: true,
});

// Mock import.meta.env
vi.mock('import.meta', () => ({
  env: { VITE_TURNSTILE_SITE_KEY: "1x00000000000000000000AA" }
}), { virtual: true });

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Import after mocks
let AuthScreen;
beforeEach(async () => {
  vi.resetModules();
  // Re-apply mocks after reset
  Object.defineProperty(window, 'turnstile', {
    value: { render: vi.fn(), reset: vi.fn() },
    writable: true,
  });
  mockFetch.mockReset();
  AuthScreen = (await import("../src/components/AuthScreen.jsx")).default;
});

describe("AuthScreen", () => {
  const defaultProps = {
    onAuth: vi.fn(),
    onGuest: vi.fn(),
  };

  it("should render login form by default", () => {
    render(<AuthScreen {...defaultProps} />);
    expect(screen.getByText("Portal Heaven")).toBeInTheDocument();
    expect(screen.getAllByText("Login").length).toBeGreaterThan(0);
    expect(screen.getByText("Register")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Username")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Password")).toBeInTheDocument();
  });

  it("should switch to register tab and show email field", () => {
    render(<AuthScreen {...defaultProps} />);
    fireEvent.click(screen.getByText("Register"));
    expect(screen.getByPlaceholderText("email@example.com")).toBeInTheDocument();
  });

  it("should switch to forgot password form", () => {
    render(<AuthScreen {...defaultProps} />);
    fireEvent.click(screen.getByText("Forgot Password?"));
    expect(screen.getByText("Reset Password")).toBeInTheDocument();
    expect(screen.getByText("Back to Login")).toBeInTheDocument();
  });

  it("should toggle password visibility", () => {
    render(<AuthScreen {...defaultProps} />);
    const passwordInput = screen.getByPlaceholderText("Password");
    const toggleBtn = screen.getByTitle("Show password");
    expect(passwordInput.type).toBe("password");
    fireEvent.click(toggleBtn);
    expect(passwordInput.type).toBe("text");
    fireEvent.click(screen.getByTitle("Hide password"));
    expect(passwordInput.type).toBe("password");
  });

  it("should show error on login failure", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: "Invalid credentials" }),
    });
    render(<AuthScreen {...defaultProps} />);
    fireEvent.change(screen.getByPlaceholderText("Username"), { target: { value: "test" } });
    fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "wrong" } });
    const loginButtons = screen.getAllByText("Login");
    fireEvent.click(loginButtons[loginButtons.length - 1]);
    await waitFor(() => {
      expect(screen.getByText(/Invalid credentials/)).toBeInTheDocument();
    });
  });

  it("should call onAuth on successful login", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ user: { id: "1", username: "test" } }),
    });
    render(<AuthScreen {...defaultProps} />);
    fireEvent.change(screen.getByPlaceholderText("Username"), { target: { value: "test" } });
    fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "pass" } });
    const loginButtons = screen.getAllByText("Login");
    fireEvent.click(loginButtons[loginButtons.length - 1]);
    await waitFor(() => {
      expect(defaultProps.onAuth).toHaveBeenCalledWith({ id: "1", username: "test" });
    });
  });

  it("should call onGuest on guest login", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}),
    });
    render(<AuthScreen {...defaultProps} />);
    fireEvent.click(screen.getByText("Continue as Guest"));
    await waitFor(() => {
      expect(defaultProps.onGuest).toHaveBeenCalled();
    });
  });

  it("should show message on forgot password success", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ message: "Reset link sent!" }),
    });
    render(<AuthScreen {...defaultProps} />);
    fireEvent.click(screen.getByText("Forgot Password?"));
    fireEvent.change(screen.getByPlaceholderText("email@example.com"), { target: { value: "test@example.com" } });
    fireEvent.click(screen.getByText("Send Reset Link"));
    await waitFor(() => {
      expect(screen.getByText("Reset link sent!")).toBeInTheDocument();
    });
  });
});
