import { describe, expect, it } from "vitest";
import { buildCommandPlan } from "../test-merge-gate.mjs";

describe("buildCommandPlan", () => {
  it("runs doc counts for docs-only changes", () => {
    expect(buildCommandPlan(["docs/testing.md"])).toEqual([
      {
        cmd: "npm run check:doc-counts",
        reasons: ["Documentation files changed"],
      },
    ]);
  });

  it("adds build and seo checks for frontend export changes", () => {
    expect(buildCommandPlan(["src/app/page.tsx"]).map((item) => item.cmd)).toEqual([
      "npm run lint",
      "cd worker && npx tsc --noEmit",
      "npm run build",
      "npm run seo:check",
    ]);
  });

  it("deduplicates shared coverage work across gate categories", () => {
    expect(buildCommandPlan([
      "worker/src/api/status.ts",
      "worker/src/cron/sync-yield-data.ts",
      ".github/workflows/validate-ci.yml",
    ])).toEqual([
      {
        cmd: "npm run lint",
        reasons: ["TypeScript/JavaScript files changed"],
      },
      {
        cmd: "cd worker && npx tsc --noEmit",
        reasons: ["Worker/shared TypeScript compatibility check"],
      },
      {
        cmd: "npm run test:critical-contracts",
        reasons: ["Critical API/shared contract files changed"],
      },
      {
        cmd: "npm run coverage:critical",
        reasons: [
          "Critical API/shared contract files changed",
          "Cron or worker library files changed",
          "Workflow/gating infrastructure changed",
        ],
      },
      {
        cmd: "npm run test:invariants",
        reasons: ["Cron or worker library files changed"],
      },
      {
        cmd: "npm test",
        reasons: ["Workflow/gating infrastructure changed"],
      },
    ]);
  });
});
