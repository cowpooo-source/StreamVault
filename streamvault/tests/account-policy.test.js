import { describe, expect, it } from "vitest";
import { isAdEligibleRole } from "../src/account-policy.js";

describe("account advertising policy", () => {
  it.each(["guest", "free"])("shows ads for %s accounts", (role) => {
    expect(isAdEligibleRole(role)).toBe(true);
  });

  it.each(["regular", "pro", "admin"])("does not show ads for %s accounts", (role) => {
    expect(isAdEligibleRole(role)).toBe(false);
  });

  it("does not show ads before an account role is known", () => {
    expect(isAdEligibleRole(null)).toBe(false);
  });
});
