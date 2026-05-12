import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("check-redemption-backstops CLI", () => {
  it("writes deterministic JSON report data", () => {
    const reportPath = join(mkdtempSync(join(tmpdir(), "redemption-backstops-")), "report.json");

    execFileSync("npx", ["tsx", "scripts/check-redemption-backstops.ts", "--report", reportPath], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test reads its own temp report path.
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    expect(report.summary.configuredCount).toBe(264);
    expect(report.auditRows).toHaveLength(264);
    expect(report.auditRows[0]).toMatchObject({
      stablecoinId: expect.any(String),
      routeFamily: expect.any(String),
      capacityConfidence: expect.any(String),
    });
    expect(report.auditRows[0]).toHaveProperty("reviewedAt");
  });
});
