import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import { createAuthRouter } from "../src/routes/auth";

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  TURNSTILE_REQUIRED: process.env.TURNSTILE_REQUIRED,
  TURNSTILE_SECRET_KEY: process.env.TURNSTILE_SECRET_KEY,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function makeApp({ nodeEnv, required, secret, fetchImpl = vi.fn() }) {
  process.env.NODE_ENV = nodeEnv;
  process.env.TURNSTILE_REQUIRED = required ? "true" : "false";
  if (secret === undefined) delete process.env.TURNSTILE_SECRET_KEY;
  else process.env.TURNSTILE_SECRET_KEY = secret;

  const app = express();
  app.use("/api", createAuthRouter({
    auth: {
      authenticate: vi.fn().mockResolvedValue({
        token: "session-token",
        user: { id: 1, username: "testuser", role: "free" },
      }),
      requireAuth: (req, res, next) => next(),
      requireRole: () => (req, res, next) => next(),
      revokeToken: vi.fn(),
    },
    email: {},
    fetch: fetchImpl,
  }));
  return app;
}

describe("Turnstile enforcement", () => {
  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
  });

  it("fails closed in production when the secret is missing", async () => {
    const app = makeApp({ nodeEnv: "production", secret: undefined });

    const response = await request(app)
      .post("/api/auth/login")
      .send({ username: "testuser", password: "Password123" });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: "CAPTCHA is not configured",
      code: "captcha_unavailable",
    });
  });

  it("rejects an invalid token when Turnstile is configured", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({ success: false }),
    });
    const app = makeApp({
      nodeEnv: "production",
      secret: "turnstile-secret",
      fetchImpl,
    });

    const response = await request(app)
      .post("/api/auth/login")
      .send({
        username: "testuser",
        password: "Password123",
        cf_turnstile_response: "invalid-token",
      });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: "CAPTCHA failed",
      code: "captcha_failed",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
