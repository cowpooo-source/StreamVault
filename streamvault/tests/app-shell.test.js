import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appHtml = readFileSync(resolve(process.cwd(), "app.html"), "utf8");

describe("application shell", () => {
  it("loads Turnstile as a classic async script", () => {
    expect(appHtml).toContain(
      '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>',
    );
    expect(appHtml).not.toContain(
      '<script type="module" src="https://challenges.cloudflare.com/turnstile/v0/api.js"',
    );
  });
});
