/* eslint-disable security/detect-non-literal-fs-filename */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanSupplyHelperUsage } from "../check-supply-helper-usage.mjs";

let tempDirs: string[] = [];

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pharos-supply-helper-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("supply helper usage check", () => {
  it("flags route/component imports of sumPegBuckets from the shared supply helper", () => {
    const cwd = makeTempRepo();
    mkdirSync(join(cwd, "src/app/demo"), { recursive: true });
    writeFileSync(
      join(cwd, "src/app/demo/page.tsx"),
      'import { sumPegBuckets } from "@shared/lib/supply";\nexport const value = sumPegBuckets({ peggedUSD: 1 });\n',
    );

    const report = scanSupplyHelperUsage({ cwd, roots: ["src/app"] });

    expect(report.violations).toEqual([
      {
        file: "src/app/demo/page.tsx",
        reason: "Route/component StablecoinData current supply should use getCirculatingRaw().",
      },
    ]);
  });

  it("allows named raw bucket parser waivers", () => {
    const cwd = makeTempRepo();
    mkdirSync(join(cwd, "worker/src/api"), { recursive: true });
    writeFileSync(
      join(cwd, "worker/src/api/backfill-depegs-extraction.ts"),
      'import { sumPegBuckets } from "@shared/lib/supply";\nexport const value = sumPegBuckets({ peggedUSD: 1 });\n',
    );

    const report = scanSupplyHelperUsage({ cwd, roots: ["worker/src/api"] });

    expect(report.violations).toEqual([]);
  });
});
