import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appSource = readFileSync(resolve(process.cwd(), "src/App.jsx"), "utf8");

describe("Compare Plans app integration", () => {
  it("mounts the dialog and owns its open state", () => {
    expect(appSource).toMatch(/import ComparePlansDialog from ['"]\.\/components\/ComparePlansDialog\.jsx['"]/);
    expect(appSource).toMatch(/const \[showPlanComparison, setShowPlanComparison\] = useState\(false\)/);
    expect(appSource).toMatch(/<ComparePlansDialog[\s\S]*isOpen=\{showPlanComparison\}/);
  });

  it("passes the plan opener to SettingsView", () => {
    expect(appSource).toMatch(/<SettingsView[\s\S]*onOpenPlans=\{\(\) => setShowPlanComparison\(true\)\}/);
  });
});
