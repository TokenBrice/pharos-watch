import { describe, expect, it } from "vitest";
import {
  buildCiValidateCommands,
  buildCommandPlan,
  getCommandEnv,
  NON_NEGOTIABLE_VALIDATE_COMMANDS,
  PAGES_VALIDATE_COMMANDS,
} from "../test-merge-gate.mjs";

describe("buildCommandPlan", () => {
  it("always runs the shared CI validate core, even for docs-only changes", () => {
    // docs/ triggers check:doc-counts; migrations, cron-sync, cron-connections, redemption-backstops are skipped
    const skipped = new Set([
      "npm run check:migrations",
      "npm run check:cron-sync",
      "npm run check:cron-connections",
      "npm run check:redemption-backstops",
    ]);
    expect(buildCommandPlan(["docs/testing.md"])).toEqual(
      NON_NEGOTIABLE_VALIDATE_COMMANDS.filter((cmd) => !skipped.has(cmd)).map((cmd) => ({
        cmd,
        reasons: ["Local merge gate mirrors the shared CI validate core"],
      })),
    );
  });

  it("adds build and seo checks for frontend export changes", () => {
    // src/app/page.tsx doesn't match any skippable prefix → all 5 skippable checks are skipped
    const skipped = new Set([
      "npm run check:migrations",
      "npm run check:cron-sync",
      "npm run check:cron-connections",
      "npm run check:doc-counts",
      "npm run check:redemption-backstops",
    ]);
    expect(buildCommandPlan(["src/app/page.tsx"]).map((item) => item.cmd)).toEqual([
      ...NON_NEGOTIABLE_VALIDATE_COMMANDS.filter((cmd) => !skipped.has(cmd)),
      ...PAGES_VALIDATE_COMMANDS,
    ]);
  });

  it("adds build and seo checks for non-route Pages-impacting files", () => {
    const skipped = new Set([
      "npm run check:migrations",
      "npm run check:cron-sync",
      "npm run check:cron-connections",
      "npm run check:doc-counts",
      "npm run check:redemption-backstops",
    ]);
    const filteredCore = NON_NEGOTIABLE_VALIDATE_COMMANDS.filter((cmd) => !skipped.has(cmd));

    expect(buildCommandPlan(["functions/api/admin/[[path]].ts"]).map((item) => item.cmd)).toEqual([
      ...filteredCore,
      ...PAGES_VALIDATE_COMMANDS,
    ]);

    expect(buildCommandPlan(["src/lib/api.ts"]).map((item) => item.cmd)).toEqual([
      ...filteredCore,
      ...PAGES_VALIDATE_COMMANDS,
    ]);

    expect(buildCommandPlan(["shared/lib/classification.ts"]).map((item) => item.cmd)).toEqual([
      ...filteredCore,
      ...PAGES_VALIDATE_COMMANDS,
    ]);
  });

  it("adds build and seo checks for Pages workflow-only changes", () => {
    const skipped = new Set([
      "npm run check:migrations",
      "npm run check:cron-sync",
      "npm run check:cron-connections",
      "npm run check:doc-counts",
      "npm run check:redemption-backstops",
    ]);
    expect(buildCommandPlan([".github/workflows/pages-release.yml"]).map((item) => item.cmd)).toEqual([
      ...NON_NEGOTIABLE_VALIDATE_COMMANDS.filter((cmd) => !skipped.has(cmd)),
      ...PAGES_VALIDATE_COMMANDS,
    ]);
  });

  it("keeps the validate core stable when worker files all change together", () => {
    // worker/src/* doesn't match any skippable prefix → all 5 skippable checks are skipped
    const skipped = new Set([
      "npm run check:migrations",
      "npm run check:cron-sync",
      "npm run check:cron-connections",
      "npm run check:doc-counts",
      "npm run check:redemption-backstops",
    ]);
    expect(buildCommandPlan([
      "worker/src/api/status.ts",
      "worker/src/cron/sync-yield-data.ts",
    ])).toEqual(
      NON_NEGOTIABLE_VALIDATE_COMMANDS.filter((cmd) => !skipped.has(cmd)).map((cmd) => ({
        cmd,
        reasons: ["Local merge gate mirrors the shared CI validate core"],
      })),
    );
  });

  it("runs skippable checks when their relevant files change", () => {
    // worker/migrations triggers check:migrations; worker/wrangler.toml triggers check:cron-sync + check:cron-connections
    // docs/ triggers check:doc-counts; shared/lib/redemption-backstop-configs/ triggers check:redemption-backstops
    // None of these match Pages-deploy prefixes (worker/* and docs/* are not in PAGES_CHANGE_PREFIXES)
    const allSkippableFiles = [
      "worker/migrations/0001_init.sql",
      "worker/wrangler.toml",
      "docs/architecture.md",
      "shared/lib/redemption-backstop-configs/usdt.ts",
    ];
    // shared/* triggers hasPagesDeployImpact, but worker/* and docs/* do not — however
    // shared/lib/redemption-backstop-configs/ starts with shared/ which does trigger pages.
    // So we expect all non-negotiable commands + pages commands.
    expect(buildCommandPlan(allSkippableFiles).map((item) => item.cmd)).toEqual([
      ...NON_NEGOTIABLE_VALIDATE_COMMANDS,
      ...PAGES_VALIDATE_COMMANDS,
    ]);
  });

  it("provides the changed-file set to the local critical coverage command", () => {
    expect(getCommandEnv("npm run coverage:critical", [
      "worker/src/api/status.ts",
      "docs/testing.md",
    ])).toEqual({
      CRITICAL_COVERAGE_CHANGED_FILES: "worker/src/api/status.ts,docs/testing.md",
    });

    expect(getCommandEnv("npm test", ["worker/src/api/status.ts"])).toEqual({});
  });

  it("builds the expected shared CI validate command sequence", () => {
    expect(buildCiValidateCommands()).toEqual([
      "npm run audit:deps",
      "npm run lint",
      "npm run check:worker-boundary",
      "npm run check:migrations",
      "npm run check:cron-sync",
      "npm run check:cron-connections",
      "npm run check:doc-counts",
      "npm run check:doc-sync",
      "npm run check:duplicate-exports",
      "npm run check:redemption-backstops",
      "npm run check:unused-code",
      "npm run check:hotspot-ratchet",
      "npm run build",
      "npm run seo:check",
      "npm test",
      "npm run coverage:critical",
      "cd worker && npx tsc --noEmit",
    ]);
  });
});
