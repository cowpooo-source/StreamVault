import { Buffer } from "node:buffer";
import { test, expect } from "./fixtures/app.fixture.js";
import {
  mockAppBackend,
  mockLoggedOutUser,
  mockLoginSuccess,
  mockTurnstile,
} from "./fixtures/auth.fixture.js";

function backupWithConnections(count) {
  return {
    _portal_heaven_export: true,
    version: 1,
    connections: Array.from({ length: count }, (_, index) => ({
      id: `m3u:http://provider.test/${index}.m3u8`,
      type: "m3u",
      label: `Imported ${index + 1}`,
      config: { type: "m3u", url: `http://provider.test/${index}.m3u8` },
    })),
  };
}

async function reachSetupAs(appPage, role, maxConnections) {
  await mockLoggedOutUser(appPage);
  await mockLoginSuccess(appPage, { role, maxConnections, limits: { maxConnections } });
  await mockTurnstile(appPage);
  await mockAppBackend(appPage);
  await appPage.addInitScript(() => {
    localStorage.setItem("sv-disclaimer-accepted", "1");
    localStorage.removeItem("sv-connections");
  });
  await appPage.goto("/app");
  await appPage.getByPlaceholder("Username").fill(`${role}-user`);
  await appPage.getByPlaceholder("Password").fill("test-pass");
  await appPage.getByRole("button", { name: "Login" }).last().click();
  await expect(appPage.getByText(new RegExp(`${role}.*0/${maxConnections} connections`, "i"))).toBeVisible();
}

for (const [role, maxConnections] of [["free", 2], ["regular", 5], ["pro", 10]]) {
  test(`${role} backup import is capped at ${maxConnections} connections`, async ({ appPage }) => {
    await reachSetupAs(appPage, role, maxConnections);
    await appPage.getByRole("button", { name: "Import" }).click();

    const dialogPromise = appPage.waitForEvent("dialog");
    await appPage.locator('input[type="file"][accept=".json"]').setInputFiles({
      name: `${role}-backup.json`,
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(backupWithConnections(maxConnections + 1))),
    });
    const dialog = await dialogPromise;
    expect(dialog.message()).toContain(`${maxConnections} new of ${maxConnections + 1} connections`);
    expect(dialog.message()).toContain("1 skipped");
    expect(dialog.message()).toContain(`account limit: ${maxConnections}`);
    await dialog.dismiss();

    await expect(appPage.getByText(new RegExp(`${role}.*${maxConnections}/${maxConnections} connections`, "i"))).toBeVisible();
  });
}
