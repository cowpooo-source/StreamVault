import { describe, it, expect, vi, beforeEach } from "vitest";
import * as emailService from "../src/email";

describe("email service", () => {
  const mockPost = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BREVO_API_KEY = "test-key";
    global.fetch = mockPost;
  });

  it("sendVerificationEmail posts to Brevo", async () => {
    mockPost.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ messageId: "123" }),
    });

    const result = await emailService.sendVerificationEmail("test@example.com", "token123", { username: "testuser" });

    expect(result).toBe(true);
    expect(mockPost).toHaveBeenCalledWith(
      "https://api.brevo.com/v3/smtp/email",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "api-key": "test-key",
        }),
      })
    );
  });

  it("sendPasswordResetEmail posts to Brevo", async () => {
    mockPost.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ messageId: "456" }),
    });

    const result = await emailService.sendPasswordResetEmail("reset@example.com", "reset-token", { username: "resetuser" });

    expect(result).toBe(true);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it("sendEmail returns false when Brevo returns an error", async () => {
    mockPost.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ message: "API Error" }),
    });

    const result = await emailService.sendEmail({ to: "fail@example.com", subject: "test", html: "<p>test</p>" });

    expect(result).toBe(false);
  });

  it("sendEmail returns false when Brevo request throws", async () => {
    mockPost.mockRejectedValue(new Error("Network error"));

    const result = await emailService.sendEmail({ to: "fail@example.com", subject: "test", html: "<p>test</p>" });

    expect(result).toBe(false);
  });
});
