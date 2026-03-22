import { describe, expect, it } from "vitest";
import { buildCommandPlan, NON_NEGOTIABLE_VALIDATE_COMMANDS } from "../test-merge-gate.mjs";

describe("buildCommandPlan", () => {
  it("always runs the shared CI validate core, even for docs-only changes", () => {
    expect(buildCommandPlan(["docs/testing.md"])).toEqual(
      NON_NEGOTIABLE_VALIDATE_COMMANDS.map((cmd) => ({
        cmd,
        reasons: ["Local merge gate mirrors the shared CI validate core"],
      })),
    );
  });

  it("adds build and seo checks for frontend export changes", () => {
    expect(buildCommandPlan(["src/app/page.tsx"]).map((item) => item.cmd)).toEqual([
      ...NON_NEGOTIABLE_VALIDATE_COMMANDS,
      "npm run build",
      "npm run seo:check",
    ]);
  });

  it("keeps the validate core stable when worker, API, and workflow files all change together", () => {
    expect(buildCommandPlan([
      "worker/src/api/status.ts",
      "worker/src/cron/sync-yield-data.ts",
      ".github/workflows/validate-ci.yml",
    ])).toEqual(
      NON_NEGOTIABLE_VALIDATE_COMMANDS.map((cmd) => ({
        cmd,
        reasons: ["Local merge gate mirrors the shared CI validate core"],
      })),
    );
  });
});
