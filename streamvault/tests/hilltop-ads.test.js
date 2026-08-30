import { describe, expect, it, beforeEach } from "vitest";
import {
  HILLTOP_POPUNDER_SELECTOR,
  injectHilltopPopunder,
} from "../src/hilltop-ads.js";

describe("Hilltop popunder loader", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
  });

  it("adds the configured script with the provider settings shape", () => {
    const script = injectHilltopPopunder({
      documentRef: document,
      url: "https://crookedagreement.com/popunder.js",
    });

    expect(script).not.toBeNull();
    expect(script.dataset.svHilltopPopunder).toBe("true");
    expect(script.src).toBe("https://crookedagreement.com/popunder.js");
    expect(script.async).toBe(true);
    expect(script.referrerPolicy).toBe("no-referrer-when-downgrade");
    expect(script.settings).toEqual({});
    expect(document.head.querySelectorAll(HILLTOP_POPUNDER_SELECTOR)).toHaveLength(1);
  });

  it("does not inject a second loader when the app rerenders", () => {
    const options = {
      documentRef: document,
      url: "https://crookedagreement.com/popunder.js",
    };

    const first = injectHilltopPopunder(options);
    const second = injectHilltopPopunder(options);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(document.head.querySelectorAll(HILLTOP_POPUNDER_SELECTOR)).toHaveLength(1);
  });
});
