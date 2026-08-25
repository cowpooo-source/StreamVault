import { describe, expect, it } from "vitest";
import { classifyProviderError } from "../src/services/stalkerErrorClassifier.js";

describe("classifyProviderError", () => {
  it.each([
    [{ code: "URL_NOT_ALLOWED" }, 403, "url_not_allowed"],
    [{ status: 403 }, 403, "authorization_failure"],
    [{ statusCode: 429 }, 429, "rate_limited"],
    [{ code: "ETIMEDOUT" }, 504, "provider_timeout"],
    [{ status: 404 }, 404, "content_not_found"],
    [new Error("No stream URL returned"), 404, "content_not_found"],
    [new Error("unexpected provider response"), 502, "provider_failure"],
  ])("maps %# to a stable response", (error, status, code) => {
    expect(classifyProviderError(error)).toEqual({ status, code });
  });
});
