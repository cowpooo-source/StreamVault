/**
 * Browser storage helpers for E2E tests.
 *
 * Provides utilities to inspect and assert on localStorage, sessionStorage,
 * IndexedDB, cookies, and console output without leaking credentials.
 */

/**
 * Dump all browser storage as a plain object.
 * Keys are prefixed: "ls:", "ss:", "cookie:".
 */
export async function dumpBrowserStorage(page) {
  return page.evaluate(() => {
    const result = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        result[`ls:${key}`] = localStorage.getItem(key);
      }
    } catch { /* localStorage may be unavailable */ }
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        result[`ss:${key}`] = sessionStorage.getItem(key);
      }
    } catch { /* sessionStorage may be unavailable */ }
    try {
      result["cookie"] = document.cookie;
    } catch { /* cookies may be blocked */ }
    return result;
  });
}

/**
 * Assert that no browser storage contains sensitive credential values.
 *
 * @param {import("@playwright/test").Page} page
 * @param {string[]} sensitiveValues - values that must NOT appear in any storage
 */
export async function assertNoCredentialsInStorage(page, sensitiveValues) {
  const storage = await dumpBrowserStorage(page);
  const storageText = JSON.stringify(storage);
  for (const value of sensitiveValues) {
    if (value && storageText.includes(value)) {
      throw new Error(`Sensitive value "${value.slice(0, 4)}***" found in browser storage`);
    }
  }
}
