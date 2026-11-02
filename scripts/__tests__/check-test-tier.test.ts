import { describe, expect, it } from "vitest";
import { checkTestTier, collectTestTierViolations } from "../ci/check-test-tier";
import { collectNightlyTestFiles } from "../lib/nightly-test-tier.mts";
import { withTempRepo } from "./helpers/test-state";

const OWNER = "scripts/__tests__/owner.test.ts";
const SWEEP = "scripts/__tests__/corpus-sweep.nightly.test.ts";
const HEADER = "// Nightly tier: PR coverage retained by";

describe("nightly test tier guard", () => {
  it("discovers only *.nightly.test files under the executable roots", () => {
    withTempRepo("pharos-test-tier", {
      [OWNER]: "it(\"owner\", () => {});\n",
      [SWEEP]: `${HEADER} ${OWNER}\nit(\"sweep\", () => {});\n`,
      "src/__tests__/unit.spec.ts": "it(\"unit\", () => {});\n",
    }, (cwd) => expect(collectNightlyTestFiles(cwd)).toEqual([SWEEP]));
  });

  it("accepts a nightly file whose header names an existing PR-tier owner", () => {
    const violations = withTempRepo("pharos-test-tier", {
      [OWNER]: "it(\"owner\", () => {});\n",
      [SWEEP]: `${HEADER} ${OWNER}\nit(\"sweep\", () => {});\n`,
    }, (cwd) => collectTestTierViolations({ cwd, nightlyFiles: [SWEEP], safetyNet: [{ name: "ALWAYS_RUN_TEST_FILES", tests: [OWNER] }] }));
    expect(violations).toEqual([]);
  });

  it.each([
    ["no header", "it(\"sweep\", () => {});\n", "missing-pr-pointer"],
    ["self-referential header", `${HEADER} ${SWEEP}\nit(\"sweep\", () => {});\n`, "nightly-pr-pointer"],
    ["unknown PR-tier owner", `${HEADER} scripts/__tests__/absent.test.ts\nit(\"sweep\", () => {});\n`, "missing-pr-pointer-target"],
  ])("rejects a nightly file with %s", (_label, source, kind) => {
    const violations = withTempRepo("pharos-test-tier", {
      [OWNER]: "it(\"owner\", () => {});\n",
      [SWEEP]: source,
    }, (cwd) => collectTestTierViolations({ cwd, nightlyFiles: [SWEEP], safetyNet: [] }));
    expect(violations.map((violation) => violation.kind)).toEqual([kind]);
  });

  it.each([
    ["a nightly file", [SWEEP], "it(\"sweep\", () => {});\n", "nightly-file-in-pr-tier"],
    ["a nightly-tagged case", [OWNER], `it("slow", { tags: ["nightly"] }, () => {});\n`, "nightly-case-in-pr-tier"],
    ["a nightly-tagged suite", [OWNER], `describe("slow", { tags: "nightly" }, () => {});\n`, "nightly-case-in-pr-tier"],
    ["a missing test", ["scripts/__tests__/absent.test.ts"], undefined, "missing-pr-tier-test"],
  ])("rejects %s in a PR-tier safety-net list", (_label, tests, source, kind) => {
    const files = source === undefined ? {} : { [tests[0]]: source };
    const violations = withTempRepo("pharos-test-tier", files, (cwd) => collectTestTierViolations({
      cwd,
      nightlyFiles: [],
      safetyNet: [{ name: "ALWAYS_RUN_TEST_FILES", tests }],
    }));
    expect(violations.map((violation) => violation.kind)).toEqual([kind]);
  });

  it("ignores a commented-out tag so prose cannot fail the guard", () => {
    const violations = withTempRepo("pharos-test-tier", {
      [OWNER]: "// tags: \"nightly\" once this sweeps the registry\nit(\"owner\", () => {});\n",
    }, (cwd) => collectTestTierViolations({ cwd, nightlyFiles: [], safetyNet: [{ name: "ALWAYS_RUN_TEST_FILES", tests: [OWNER] }] }));
    expect(violations).toEqual([]);
  });

  it("reports the PR-tier safety net and every nightly file on success and failure", () => {
    const wrote = { stdout: "", stderr: "" };
    const stdout = { write: (chunk: string) => { wrote.stdout += chunk; return true; } };
    const stderr = { write: (chunk: string) => { wrote.stderr += chunk; return true; } };
    expect(checkTestTier({ nightlyFiles: [], stdout, stderr })).toBe(0);
    expect(wrote.stdout).toContain("0 nightly-tier file(s)");
    expect(wrote.stdout).toContain("no nightly file or case outside the tier");
    expect(wrote.stderr).toBe("");
  });
});
