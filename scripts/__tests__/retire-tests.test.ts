import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DERIVED_PROTECTED_TEST_FILES,
  applyRetirementPlan,
  formatRetirementPlan,
  planTestRetirement,
} from "../maintenance/retire-tests.ts";
import { createTempRepoTracker } from "./helpers/test-state";

const { makeRoot, writeText, writeJson, cleanup } = createTempRepoTracker("pharos-retire-tests");
afterEach(cleanup);

const OLD = "worker/src/lib/__tests__/old-weather.test.ts";
const OWNER = "shared/lib/__tests__/weather-owner.test.ts";
const NEXT = "shared/lib/__tests__/weather-owner-next.test.ts";
const HELPER = "scripts/__tests__/old-helper.test.ts";
const SOLO = "worker/src/lib/__tests__/solo-weather.test.ts";
const LANE_ONLY = "scripts/__tests__/lane-only-helper.test.ts";
const PAIR = ["worker/src/lib/__tests__/pair-a.test.ts", "worker/src/lib/__tests__/pair-b.test.ts"] as const;

function fixture(): string {
  const root = makeRoot();
  writeText(root, OLD, [
    'import { describe, it } from "vitest";',
    'describe("weather", () => {',
    '  it("returns a forecast", () => {});',
    '  it("retains the last good reading", () => {});',
    "});",
    "",
  ].join("\n"));
  writeText(root, OWNER, 'import { it } from "vitest";\nit("owns the weather contract", () => {});\n');
  writeText(root, NEXT, 'import { it } from "vitest";\nit("owns the retired weather contract", () => {});\n');
  writeText(root, HELPER, 'import { it } from "vitest";\nit("normalizes helper input", () => {});\n');
  writeText(root, LANE_ONLY, 'import { it } from "vitest";\nit("owns the lane-only contract", () => {});\n');
  writeText(root, SOLO, 'import { it } from "vitest";\nit("owns the solo contract", () => {});\n');
  for (const pair of PAIR) writeText(root, pair, 'import { it } from "vitest";\nit("owns the pair contract", () => {});\n');
  writeText(root, "scripts/lib/critical-test-files.mts", [
    "export const CRITICAL_CONTRACT_TEST_FILES: string[] = [",
    `  "${OWNER}",`,
    `  "${OLD}",`,
    "];",
    "",
  ].join("\n"));
  writeText(root, "scripts/lib/provider-resilience-registry.mjs", [
    "export const PROVIDER_RESILIENCE_REGISTRY = [",
    "  {",
    '    id: "weather",',
    "    tests: [",
    `      "${OLD}",`,
    `      "${OWNER}",`,
    "    ],",
    "  },",
    "  {",
    '    id: "solo",',
    "    tests: [",
    `      "${SOLO}",`,
    "    ],",
    "  },",
    "  {",
    '    id: "pair",',
    "    tests: [",
    `      "${PAIR[0]}",`,
    `      "${PAIR[1]}",`,
    "    ],",
    "  },",
    "];",
    "",
  ].join("\n"));
  writeJson(root, "docs/doc-ownership.json", {
    version: 2,
    mappings: [
      { id: "weather", sources: ["worker/src/lib/weather*"], testOwnership: [{ sources: ["worker/src/lib/weather*"], tests: [OLD, OWNER] }] },
      { id: "solo", sources: ["worker/src/lib/solo*"], testOwnership: [{ sources: ["worker/src/lib/solo*"], tests: [SOLO] }] },
      { id: "pair", sources: ["worker/src/lib/pair*"], testOwnership: [{ sources: ["worker/src/lib/pair*"], tests: [...PAIR] }] },
    ],
  });
  writeText(root, "scripts/lib/critical-coverage.mjs", [
    "export const CRITICAL_COVERAGE_WAIVERS = {",
    '  "worker/src/lib/weather.ts": {',
    '    reviewAfter: "2026-12-15",',
    '    reason: "Export-only facade.",',
    `    ownerTest: "${OWNER}",`,
    "  },",
    "};",
    "",
  ].join("\n"));
  writeText(root, "scripts/lib/critical-ownership.mts", [
    "export const ISOLATED_NODE_TESTS = [",
    `  "${HELPER}",`,
    "];",
    "export const THREADED_WORKER_TESTS = [",
    `  "${HELPER}",`,
    "];",
    "export const WORKER_SHARED_TEST_FILES = [",
    '  "worker/src/cron/reserve-adapters/__tests__/kept-helper.test.ts",',
    `  "${HELPER}"`,
    "];",
    "",
  ].join("\n"));
  writeText(root, "scripts/lib/pr-lanes.mts", [
    "export const PR_DOC_COMMANDS = [",
    `  { id: "doc-ownership-invariants", program: "npm", args: ["exec", "--", "vitest", "run", "scripts/__tests__/doc-ownership-registry.test.ts", "${HELPER}"] },`,
    "];",
    "export const PR_GUARD_COMMANDS = [",
    `  { id: "lane-only", program: "npm", args: ["exec", "--", "vitest", "run", "${LANE_ONLY}"] },`,
    "];",
    "",
  ].join("\n"));
  writeText(root, "scripts/maintenance/run-v9-resource-lane.ts", `export const RESOURCE_TEST_FILE = "${OWNER}";\n`);
  writeText(root, "vitest.config.ts", "export default {};\n");
  writeText(root, "scripts/lib/notes.mts", `// Case moved out of "${OLD}".\n`);
  writeText(root, "docs/testing.md", `The retired [weather suite](${OLD}) and its old-helper.test.ts sibling.\n`);
  return root;
}

function read(root: string, file: string): string {
  return readFileSync(join(root, file), "utf8");
}

describe("retire-tests", () => {
  it("plans registry edits, hand-fix references and evidence rows without writing", () => {
    const root = fixture();
    const plan = planTestRetirement({ root, paths: [OLD], replacement: NEXT });

    expect(plan.errors).toEqual([]);
    expect(plan.edits.map((edit) => edit.file)).toEqual([
      "scripts/lib/critical-test-files.mts",
      "scripts/lib/provider-resilience-registry.mjs",
      "docs/doc-ownership.json",
    ]);
    expect(plan.edits.every((edit) => edit.action === "repoint" && edit.replacement === NEXT)).toBe(true);
    expect(plan.edits[0]!.before).toEqual([`  "${OLD}",`]);
    expect(plan.edits[0]!.after).toEqual([`  "${NEXT}",`]);
    expect(plan.manual.map((reference) => `${reference.file}:${reference.match}`)).toEqual([
      "docs/testing.md:path",
      "scripts/lib/notes.mts:path",
    ]);
    expect(plan.cases.map((evidence) => evidence.title)).toEqual([
      "returns a forecast",
      "retains the last good reading",
    ]);

    const printed = formatRetirementPlan(plan);
    expect(printed).toContain("Test retirement plan (dry run)");
    expect(printed).toContain("| Deleted case | Surviving test path | Exact test title |");
    expect(printed).toContain(`| \`${OLD}\` — "returns a forecast" | | |`);
    expect(printed).toContain(`repoint ${OLD} -> ${NEXT}`);
    expect(printed).toContain("Dry run: no files changed.");
    expect(read(root, "scripts/lib/critical-test-files.mts")).toContain(OLD);
  });

  it("removes unprotected isolation and lane references without a replacement", () => {
    const root = fixture();
    const plan = planTestRetirement({ root, paths: [HELPER] });

    expect(plan.errors).toEqual([]);
    expect(plan.edits.map((edit) => `${edit.file}:${edit.action}`)).toEqual([
      "scripts/lib/critical-ownership.mts:remove",
      "scripts/lib/critical-ownership.mts:remove",
      "scripts/lib/critical-ownership.mts:remove",
      "scripts/lib/pr-lanes.mts:remove",
    ]);
    const applied = applyRetirementPlan(plan);
    expect(applied.deleted).toEqual([HELPER]);
    const isolation = read(root, "scripts/lib/critical-ownership.mts");
    expect(isolation).not.toContain(HELPER);
    expect(isolation.match(/= \[\n\];/g)).toHaveLength(2);
    expect(isolation).toContain('WORKER_SHARED_TEST_FILES = [\n  "worker/src/cron/reserve-adapters/__tests__/kept-helper.test.ts"\n];');
    expect(read(root, "scripts/lib/pr-lanes.mts")).toContain('"scripts/__tests__/doc-ownership-registry.test.ts"]');
  });

  it("refuses a retirement that would leave a vitest run roster with no test argument", () => {
    const root = fixture();
    const plan = planTestRetirement({ root, paths: [LANE_ONLY] });

    expect(plan.errors).toContain(
      "scripts/lib/pr-lanes.mts:5: retirement edit would leave a `vitest run` roster entry with no test argument; " +
        "pass --replacement <existing test file> or edit the roster by hand",
    );
    expect(plan.writes.map((write) => write.file)).not.toContain("scripts/lib/pr-lanes.mts");
    expect(() => applyRetirementPlan(plan)).toThrow(/Refusing to apply/);
    expect(existsSync(join(root, LANE_ONLY))).toBe(true);
  });

  it("refuses a derived critical owner test without --replacement", () => {
    const root = fixture();
    // The literal registries name the enumerated half; the live import scan
    // derives the rest, so a derived-only critical path needs an owner too.
    const plan = planTestRetirement({ root, paths: [HELPER], derivedProtectedTestFiles: [HELPER] });

    expect(plan.errors).toContain(
      `${HELPER}: derived into ALWAYS_RUN_TEST_FILES/CRITICAL_TEST_FILES by the test scan (critical-ownership.mts); ` +
        "pass --replacement <existing test file> so the behaviour keeps an owner",
    );
    expect(plan.writes.map((write) => write.file)).not.toContain("scripts/lib/critical-test-files.mts");
    expect(() => applyRetirementPlan(plan)).toThrow(/Refusing to apply/);
    expect(existsSync(join(root, HELPER))).toBe(true);
  });

  it("protects the derived critical set by default", () => {
    expect(DERIVED_PROTECTED_TEST_FILES.has("worker/src/telegram/webhook/__tests__/telegram-webhook-auth.test.ts")).toBe(true);
    expect(DERIVED_PROTECTED_TEST_FILES.has("worker/src/lib/__tests__/auth.test.ts")).toBe(true);
    expect(DERIVED_PROTECTED_TEST_FILES.has("scripts/__tests__/lane-only-helper.test.ts")).toBe(false);
  });

  it("refuses a protected always-run contract without --replacement", () => {
    const root = fixture();
    const plan = planTestRetirement({ root, paths: [OLD] });

    expect(plan.errors.some((error) => error.includes("protected contract"))).toBe(true);
    expect(plan.writes.map((write) => write.file)).not.toContain("scripts/lib/critical-test-files.mts");
    const printed = formatRetirementPlan(plan);
    expect(printed.startsWith("Test retirement refused — nothing was changed:")).toBe(true);
    expect(printed).toContain("--replacement");
    expect(() => applyRetirementPlan(plan)).toThrow(/Refusing to apply/);
    expect(existsSync(join(root, OLD))).toBe(true);
  });

  it("refuses a missing or non-test replacement and malformed selections", () => {
    const root = fixture();
    const errorsFor = (paths: string[], replacement?: string) =>
      planTestRetirement({ root, paths, ...(replacement === undefined ? {} : { replacement }) }).errors;

    expect(errorsFor(["worker/src/lib/weather.ts"])).toContain("worker/src/lib/weather.ts: not a test file (*.test.* or *.spec.*)");
    expect(errorsFor(["worker/src/lib/__tests__/missing.test.ts"])).toContain(
      "worker/src/lib/__tests__/missing.test.ts: test file not found",
    );
    expect(errorsFor([OLD], "shared/lib/__tests__/missing-owner.test.ts")).toContain(
      "shared/lib/__tests__/missing-owner.test.ts: --replacement test file not found",
    );
    expect(errorsFor([OLD], "worker/src/lib/weather.ts")).toContain(
      "worker/src/lib/weather.ts: --replacement must name a test file (*.test.* or *.spec.*)",
    );
    expect(errorsFor([OLD], OLD)).toContain(`${OLD}: --replacement cannot be one of the retired paths`);
    expect(errorsFor([])).toEqual(["Provide at least one test path to retire."]);
  });

  it("refuses to orphan a provider surface or a testOwnership declaration", () => {
    const root = fixture();
    const plan = planTestRetirement({ root, paths: [SOLO] });

    expect(plan.errors).toEqual([
      "scripts/lib/provider-resilience-registry.mjs:12: removing worker/src/lib/__tests__/solo-weather.test.ts would leave tests[0] with no test; pass --replacement <existing test file>",
      "docs/doc-ownership.json:32: removing worker/src/lib/__tests__/solo-weather.test.ts would leave tests[0] with no test; pass --replacement <existing test file>",
    ]);
  });

  it("refuses two retirements that empty one owner list together", () => {
    const root = fixture();
    const plan = planTestRetirement({ root, paths: [...PAIR] });

    const orphaned = plan.errors.filter((error) => error.includes("would leave"));
    expect(orphaned).toHaveLength(2);
    expect(orphaned[0]).toContain("provider-resilience-registry.mjs");
    expect(orphaned[1]).toContain("doc-ownership.json");
    expect(plan.writes).toEqual([]);
  });

  it("applies registry edits and deletes the retired file, keeping JSON valid", () => {
    const root = fixture();
    const plan = planTestRetirement({ root, paths: [OLD], replacement: NEXT });
    const applied = applyRetirementPlan(plan);

    expect(applied.written).toEqual(plan.writes.map((write) => write.file));
    expect(applied.deleted).toEqual([OLD]);
    const ownership = JSON.parse(read(root, "docs/doc-ownership.json")) as {
      mappings: Array<{ id: string; testOwnership: Array<{ tests: string[] }> }>;
    };
    expect(ownership.mappings[0]!.testOwnership[0]!.tests).toEqual([NEXT, OWNER]);
    expect(read(root, "scripts/lib/provider-resilience-registry.mjs")).not.toContain(OLD);
    expect(existsSync(join(root, OLD))).toBe(false);

    const printed = formatRetirementPlan(plan, { applied: true });
    expect(printed.startsWith("Test retirement applied")).toBe(true);
    expect(printed).toContain("Applied: 3 registry file(s) written, 1 test file(s) deleted.");
    expect(planTestRetirement({ root, paths: [OLD] }).errors).toContain(`${OLD}: test file not found`);
  });

  it("fails closed when an enrolled registry is missing", () => {
    const root = fixture();
    const plan = planTestRetirement({ root, paths: [HELPER] });
    expect(plan.errors).toEqual([]);

    const incomplete = makeRoot();
    writeText(incomplete, HELPER, 'import { it } from "vitest";\nit("normalizes helper input", () => {});\n');
    const missing = planTestRetirement({ root: incomplete, paths: [HELPER] });
    expect(missing.errors).toContain(
      "vitest.config.ts: retirement registry missing (vitest project configuration); update RETIREMENT_REGISTRIES",
    );
  });
});
