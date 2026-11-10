import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPrTestPlan } from "../lib/pr-test-plan.mts";
import { selectPrTestFiles } from "../lib/pr-test-selection.mts";

const docRatchet = "scripts/__tests__/doc-ownership-registry.test.ts";
const router = "scripts/__tests__/pharos-change-contract.test.ts";
const manifest = "scripts/__tests__/generate-safety-score-v9-evaluation-build-manifest.test.ts";
const isolate = "scripts/__tests__/isolate-local-state-registry.test.ts";

describe("declared non-import-graph PR test ownership", () => {
  it.each([
    ["docs/report-cards.md", [docRatchet, router]],
    ["docs/worker-infrastructure.md", [docRatchet, router]],
    ["docs/status-dashboard.md", [docRatchet, router]],
    ["docs/doc-ownership.json", [docRatchet, router]],
    ["AGENTS.md", [router]],
    ["CLAUDE.md", [router]],
    ["src/AGENTS.md", [router]],
    ["worker/AGENTS.md", [router]],
    ["scripts/AGENTS.md", [router]],
    ["shared/lib/safety-score-v9/mint-posture.ts", [manifest]],
    ["shared/types/reserve-input.ts", [manifest]],
    ["shared/lib/supply.ts", [manifest, isolate]],
    ["scripts/lib/safety-score-v9-evaluation-inputs.mts", [manifest]],
    ["worker/src/lib/dex-liquidity/quote-v2.ts", [isolate]],
    ["shared/lib/isolate-local-state-registry.ts", [isolate]],
    ["functions/new-runtime.tsx", [isolate]],
    ["worker/src/lib/safety-score-v9/capture.ts", ["worker/src/lib/__tests__/safety-score-v9-capture.test.ts"]],
    ["shared/types/safety-score-v9-capture-control.ts", ["worker/src/lib/__tests__/safety-score-v9-capture-control.test.ts"]],
    ["shared/types/safety-score-capture-archive.ts", ["worker/src/lib/__tests__/safety-score-capture-archive.test.ts"]],
    ["scripts/lib/mechanism-measurement/shock-schema.ts", [manifest]],
    ["shared/data/safety-score-v9/mechanism-measurements/usdt.summary.json", [manifest]],
  ] as const)("selects declared invariant owners for %s without import-graph edges", (source, expected) => {
    const selected = selectPrTestFiles([], [], [source], new Map());
    expect(selected).toEqual(expect.arrayContaining([...expected]));
    const plan = createPrTestPlan("frozen-base", selected);
    expect(plan.shards.flat().sort()).toEqual(selected);
    expect(new Set(plan.shards.flat()).size).toBe(selected.length);
  });

  it("retains changed, mandatory, and import-derived owners alongside declarations without duplicates", () => {
    const changed = "scripts/__tests__/run-focused-checks.test.ts";
    const mandatory = "scripts/__tests__/run-pr-tests.test.ts";
    const imported = "scripts/__tests__/critical-ownership.test.ts";
    const selected = selectPrTestFiles([changed, docRatchet], [mandatory], ["docs/report-cards.md"],
      new Map([["docs/report-cards.md", [imported]]]));
    expect(selected).toEqual([changed, mandatory, imported, docRatchet, router].sort());
  });

  it("selects the router once for mixed doc and guide inputs", () => {
    const selected = selectPrTestFiles([], [], ["docs/status-dashboard.md", "AGENTS.md", "worker/AGENTS.md"], new Map());
    expect(selected.filter((file) => file === router)).toHaveLength(1);
    expect(selected).toEqual(expect.arrayContaining([docRatchet, router]));
  });

  it("fails closed when the router test is missing", () => {
    expect(() => selectPrTestFiles([], [], ["AGENTS.md"], new Map(), (file) => file !== resolve(router)))
      .toThrow(router);
  });

  it("fails closed rather than silently skipping a missing declared invariant", () => {
    expect(() => selectPrTestFiles([], [], ["docs/report-cards.md"], new Map(), (file) => file !== resolve(docRatchet)))
      .toThrow(docRatchet);
  });
});

describe("nightly-tier exclusion", () => {
  const mandatory = "scripts/__tests__/run-pr-tests.test.ts";
  const nightly = "scripts/__tests__/corpus-sweep.nightly.test.ts";

  it("drops a changed nightly-tier file and its import/declaration selection from the PR plan", () => {
    const selected = selectPrTestFiles([nightly], [mandatory], [nightly], new Map([[nightly, [nightly]]]), () => true);
    expect(selected).toEqual([mandatory]);
  });

  it("fails closed when an always-run contract names a nightly-tier file", () => {
    expect(() => selectPrTestFiles([], [nightly], [], new Map(), () => true))
      .toThrow(/always-run PR contract/);
  });
});

describe("documentation-owner dedup", () => {
  const mandatory = "scripts/__tests__/run-pr-tests.test.ts";

  it("drops the docs-driven invariant suites when the docs owner already runs them", () => {
    expect(selectPrTestFiles([], [mandatory], ["docs/testing.md"], new Map(), () => true, { docsChanged: true }))
      .toEqual([mandatory]);
  });

  it("keeps doc-owned tests the docs commands do not run", () => {
    // The static-guards docs owner runs only the two invariant suites, so a
    // doc's other declared validators must stay in the test plan.
    const doc = "docs/process/lane-freshness-matrix.md";
    const declared = (JSON.parse(readFileSync("docs/doc-ownership.json", "utf8")) as {
      mappings: Array<{ testOwnership?: Array<{ sources: string[]; tests: string[] }> }>;
    }).mappings.flatMap((mapping) => mapping.testOwnership ?? [])
      .filter((owner) => owner.sources.includes(doc))
      .flatMap((owner) => owner.tests);
    expect(declared.length).toBeGreaterThan(0);
    const selected = selectPrTestFiles([], [mandatory], [doc], new Map(), () => true, { docsChanged: true });
    expect(selected).toEqual(expect.arrayContaining([mandatory, ...declared]));
  });

  it("keeps a doc-declared suite that a non-doc source also selects", () => {
    const selected = selectPrTestFiles([], [mandatory], ["docs/testing.md", "package.json"], new Map(), () => true, { docsChanged: true });
    expect(selected).toContain(docRatchet);
    // Every router-declaration source is documentation, so the router suite
    // stays with the static-guards docs owner.
    expect(selected).not.toContain(router);
  });

  it("keeps a doc-declared suite that is also a changed test file", () => {
    const selected = selectPrTestFiles([router], [mandatory], ["docs/testing.md"], new Map(), () => true, { docsChanged: true });
    expect(selected).toEqual([router, mandatory].sort());
  });

  it("leaves the docs declarations in place when docs did not change", () => {
    const selected = selectPrTestFiles([], [mandatory], ["docs/testing.md"], new Map(), () => true);
    expect(selected).toEqual(expect.arrayContaining([docRatchet, router, mandatory]));
  });
});
