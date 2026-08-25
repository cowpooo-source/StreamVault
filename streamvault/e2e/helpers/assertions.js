import { expect } from "@playwright/test";

/**
 * Assert that no unexpected browser errors were collected.
 *
 * @param {{ pageErrors: string[], consoleErrors: string[], failedRequests: object[], badResponses: object[] }} errors
 * @param {(string | RegExp)[]} allowlist - exact strings or narrow regexes to ignore.
 */
export function assertNoUnexpectedBrowserErrors(errors, allowlist = []) {
  const isAllowed = (value) =>
    allowlist.some((entry) =>
      entry instanceof RegExp ? entry.test(value) : value === entry,
    );

  const unexpectedPageErrors = errors.pageErrors.filter(
    (msg) => !isAllowed(msg),
  );
  const unexpectedConsoleErrors = errors.consoleErrors.filter(
    (msg) => !isAllowed(msg),
  );
  const unexpectedFailed = errors.failedRequests.filter(
    (req) => !isAllowed(req.url) && !isAllowed(`${req.method} ${req.url}`),
  );
  const unexpectedBad = errors.badResponses.filter(
    (res) =>
      !isAllowed(res.url) &&
      !isAllowed(`${res.status} ${res.method} ${res.url}`) &&
      !isAllowed(`${res.status}`),
  );

  const parts = [];
  if (unexpectedPageErrors.length) {
    parts.push(`Page errors:\n${unexpectedPageErrors.map((m) => `  - ${m}`).join("\n")}`);
  }
  if (unexpectedConsoleErrors.length) {
    parts.push(`Console errors:\n${unexpectedConsoleErrors.map((m) => `  - ${m}`).join("\n")}`);
  }
  if (unexpectedFailed.length) {
    parts.push(
      `Failed requests:\n${unexpectedFailed.map((r) => `  - ${r.method} ${r.url} (${r.failure})`).join("\n")}`,
    );
  }
  if (unexpectedBad.length) {
    parts.push(
      `Bad API responses:\n${unexpectedBad.map((r) => `  - ${r.status} ${r.method} ${r.url}`).join("\n")}`,
    );
  }

  expect(parts.join("\n\n"), "Unexpected browser errors detected").toBe("");
}
