import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { createPrTestPlan } from "../lib/pr-test-plan.mts";
import { selectPrTestFiles } from "../lib/pr-test-selection.mts";

const docRatchet = "scripts/__tests__/doc-ownership-registry.test.ts";
const closure = "scripts/__tests__/veritas-ver-010-v9-evaluation-build-identity.test.ts";
const manifest = "scripts/__tests__/generate-safety-score-v9-evaluation-build-manifest.test.ts";
const isolate = "scripts/__tests__/isolate-local-state-registry.test.ts";

describe("declared non-import-graph PR test ownership", () => {
  it.each([
    ["docs/report-cards.md", [docRatchet]],
    ["docs/worker-infrastructure.md", [docRatchet]],
    ["docs/doc-ownership.json", [docRatchet]],
    ["shared/lib/safety-score-v9/mint-posture.ts", [closure, manifest]],
    ["shared/types/reserve-input.ts", [closure, manifest]],
    ["shared/lib/supply.ts", [closure, manifest, isolate]],
    ["scripts/lib/safety-score-v9-evaluation-inputs.mts", [closure, manifest]],
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
    const plan = createPrTestPlan("frozen-base", selected, {});
    expect(plan.shards.flat().sort()).toEqual(selected);
    expect(new Set(plan.shards.flat()).size).toBe(selected.length);
  });

  it("retains changed, mandatory, and import-derived owners alongside declarations without duplicates", () => {
    const changed = "scripts/__tests__/run-focused-checks.test.ts";
    const mandatory = "scripts/__tests__/run-pr-tests.test.ts";
    const imported = "scripts/__tests__/critical-ownership.test.ts";
    const selected = selectPrTestFiles([changed, docRatchet], [mandatory], ["docs/report-cards.md"],
      new Map([["docs/report-cards.md", [imported]]]));
    expect(selected).toEqual([changed, mandatory, imported, docRatchet].sort());
  });

  it("does not add input-scoped invariants to unrelated frontend changes", () => {
    const changed = "scripts/__tests__/pr-test-selection.test.ts";
    expect(selectPrTestFiles([changed], [], ["src/components/query-error-notice.tsx"], new Map())).toEqual([changed]);
  });

  it("fails closed rather than silently skipping a missing declared invariant", () => {
    expect(() => selectPrTestFiles([], [], ["docs/report-cards.md"], new Map(), (file) => file !== resolve(docRatchet)))
      .toThrow(docRatchet);
  });
});
