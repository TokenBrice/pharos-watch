import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeReceiptOutcome, explainPrCheckReceipt, firstActionableError, writePrCheckReceipt, type PrCheckReceipt, type PrCheckReceiptLeaf, type PrReceiptCheckout } from "../lib/pr-check-receipt.mts";

const passed: PrCheckReceiptLeaf = { id: "tests", command: "npm run test:pr", status: "passed", durationMs: 12 };

describe("PR verification receipts", () => {
  it("requires executed, unweakened selected leaves for a passing outcome", () => {
    expect(computeReceiptOutcome([passed], false)).toBe("passed");
    expect(computeReceiptOutcome([passed], true)).toBe("incomplete");
    expect(computeReceiptOutcome([passed, { ...passed, status: "skipped" }], false)).toBe("incomplete");
    expect(computeReceiptOutcome([passed, { ...passed, status: "not-selected" }], false)).toBe("passed");
  });

  it("retains any failed leaf, including in weakened runs", () => {
    for (const weakened of [false, true]) {
      expect(computeReceiptOutcome([passed, { ...passed, status: "failed", firstError: "Type error" }], weakened)).toBe("failed");
    }
  });

  it("extracts actionable output rather than npm banners and lifecycle wrappers", () => {
    expect(firstActionableError("> pharos-watch test\n\u001b[31mError: missing fixture\u001b[0m\nnpm error Lifecycle script failed", "exit 1"))
      .toBe("Error: missing fixture");
    expect(firstActionableError("", "spawn ENOENT")).toBe("spawn ENOENT");
  });

  it("writes a commit-bound receipt and replaces a previous passing proof on failure", () => {
    const root = mkdtempSync(join(tmpdir(), "pharos-receipt-"));
    try {
      const receipt = {
        schemaVersion: 1 as const, node: "24.16.0", npm: "11.13.0", baseSha: "b".repeat(40), headSha: "a".repeat(40),
        treeClean: true, flags: {}, weakened: false, startedAt: "2026-10-08T00:00:00.000Z", finishedAt: "2026-10-08T00:00:01.000Z",
        leaves: [passed], outcome: "passed" as const,
      };
      const path = writePrCheckReceipt(receipt, root);
      expect(path).toBe(join(root, ".tmp/pr-check-receipts", `${receipt.headSha}.json`));
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(receipt);
      writePrCheckReceipt({ ...receipt, leaves: [{ ...passed, status: "failed" }], outcome: "failed" }, root);
      expect(JSON.parse(readFileSync(path, "utf8")).outcome).toBe("failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("read-only receipt explanation", () => {
  const receipt: PrCheckReceipt = {
    schemaVersion: 1, node: "24.16.0", npm: "11.13.0", baseSha: "b".repeat(40), headSha: "a".repeat(40),
    treeClean: true, flags: { noFetch: false, forwardedTestArgs: [] }, weakened: false,
    startedAt: "2026-10-08T00:00:00.000Z", finishedAt: "2026-10-08T00:00:01.000Z",
    leaves: [passed, { id: "critical-coverage", command: "npm run test:coverage:critical", status: "deferred-to-ci", durationMs: 0 }],
    outcome: "passed",
  };
  const checkout: PrReceiptCheckout = {
    headSha: receipt.headSha, treeClean: true, baseRef: "origin/main", localBaseSha: receipt.baseSha,
  };

  it("explains a matching clean receipt without treating cached base or deferred lanes as a fresh remote proof", () => {
    const root = mkdtempSync(join(tmpdir(), "pharos-receipt-explain-"));
    try {
      const path = writePrCheckReceipt(receipt, root);
      const before = readFileSync(path, "utf8");
      const output = explainPrCheckReceipt(checkout, root);
      expect(output).toContain(`Recorded HEAD: ${receipt.headSha}`);
      expect(output).toContain(`Recorded base: ${receipt.baseSha}`);
      expect(output).toContain("Recorded runtime: Node 24.16.0; npm 11.13.0");
      expect(output).toContain(`flags: ${JSON.stringify(receipt.flags)}`);
      expect(output).toContain("Recorded tree: clean; weakened: false; outcome: passed");
      expect(output).toContain("passed | tests | 12 | npm run test:pr");
      expect(output).toContain("deferred-to-ci | critical-coverage");
      expect(output).toContain("no local invalidation observed");
      expect(output).toContain("Remote-base freshness: unknown");
      expect(output).toContain("Next action: Verify the latest remote base separately");
      expect(output).toContain("GitHub must still pass the deferred lanes (critical-coverage)");
      expect(output).toContain("no push authorization");
      expect(readFileSync(path, "utf8")).toBe(before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reports HEAD mismatch inside the current-HEAD receipt instead of trusting its filename", () => {
    const root = mkdtempSync(join(tmpdir(), "pharos-receipt-explain-"));
    try {
      const path = writePrCheckReceipt(receipt, root);
      writeFileSync(path, JSON.stringify({ ...receipt, headSha: "c".repeat(40) }));
      const output = explainPrCheckReceipt(checkout, root);
      expect(output).toContain("HEAD mismatch");
      expect(output).toContain("Next action: Resolve the limitations above");
      expect(output).toContain("then run plain npm run check:pr");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(["current", "recorded"] as const)("invalidates evidence for a %s dirty tree", (dirty) => {
    const root = mkdtempSync(join(tmpdir(), "pharos-receipt-explain-"));
    try {
      writePrCheckReceipt({ ...receipt, treeClean: dirty !== "recorded" }, root);
      const output = explainPrCheckReceipt({ ...checkout, treeClean: dirty !== "current" }, root);
      expect(output).toContain(dirty === "current" ? "Current dirty tree" : "Recorded dirty tree");
      expect(output).toContain("Next action: Resolve the limitations above");
      expect(output).toContain("final committed clean HEAD");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("names every failed lane and its actionable error before recommending full readiness", () => {
    const root = mkdtempSync(join(tmpdir(), "pharos-receipt-explain-"));
    try {
      writePrCheckReceipt({ ...receipt, outcome: "failed", leaves: [
        { ...passed, status: "failed", firstError: "Type error" },
        { ...passed, id: "docs", command: "npm run check:doc-sync", status: "failed", firstError: "Stale contract" },
      ] }, root);
      const output = explainPrCheckReceipt(checkout, root);
      expect(output).toContain("failed | tests | 12 | npm run test:pr | Type error");
      expect(output).toContain("Stale contract");
      expect(output).toContain("Next action: Fix every failed lane (tests, docs)");
      expect(output).toContain("npm run check:generated-artifacts");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reports a missing current-HEAD receipt without substituting an older commit's receipt", () => {
    const root = mkdtempSync(join(tmpdir(), "pharos-receipt-explain-"));
    try {
      writePrCheckReceipt({ ...receipt, headSha: "c".repeat(40) }, root);
      const output = explainPrCheckReceipt(checkout, root);
      expect(output).toContain(`Receipt: missing (${join(root, ".tmp/pr-check-receipts", `${checkout.headSha}.json`)})`);
      expect(output).toContain("Next action: follow docs/testing.md#pre-push-readiness");
      expect(output).not.toContain("Recorded HEAD:");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("retains weakened, incomplete and skipped limitations instead of presenting passing leaves as proof", () => {
    const root = mkdtempSync(join(tmpdir(), "pharos-receipt-explain-"));
    try {
      writePrCheckReceipt({ ...receipt, weakened: true, outcome: "incomplete", flags: { plan: true },
        incompleteReasons: ["dirty-worktree"], leaves: [{ ...passed, status: "skipped" }] }, root);
      const output = explainPrCheckReceipt(checkout, root);
      expect(output).toContain("Recorded weakened invocation");
      expect(output).toContain("Recorded incomplete outcome");
      expect(output).toContain("Recorded incomplete reasons: dirty-worktree");
      expect(output).toContain("Skipped lanes");
      expect(output).toContain("not final plain readiness");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reports changed or unavailable local bases without claiming remote observation", () => {
    const root = mkdtempSync(join(tmpdir(), "pharos-receipt-explain-"));
    try {
      writePrCheckReceipt(receipt, root);
      expect(explainPrCheckReceipt({ ...checkout, localBaseSha: "c".repeat(40) }, root))
        .toContain("Recorded base differs from the locally available base");
      expect(explainPrCheckReceipt({ ...checkout, localBaseSha: undefined }, root))
        .toContain("base identity cannot be compared");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("explains parity merge identity without replacing the required final plain receipt", () => {
    const root = mkdtempSync(join(tmpdir(), "pharos-receipt-explain-"));
    try {
      writePrCheckReceipt({ ...receipt, mode: "ci-parity", mergeSha: "c".repeat(40), mergeTree: "d".repeat(40) }, root);
      const output = explainPrCheckReceipt(checkout, root);
      expect(output).toContain("Recorded mode: ci-parity");
      expect(output).toContain(`Recorded tested merge: ${"c".repeat(40)}; tree: ${"d".repeat(40)}`);
      expect(output).toContain("not final plain readiness");
      expect(output).toContain("Next action: Resolve the limitations above");
      expect(output).toContain("then run plain npm run check:pr");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("uses the existing schema parser and rejects invalid receipts without replacing them", () => {
    const root = mkdtempSync(join(tmpdir(), "pharos-receipt-explain-"));
    try {
      const path = writePrCheckReceipt(receipt, root);
      writeFileSync(path, '{"schemaVersion":2}');
      expect(() => explainPrCheckReceipt(checkout, root)).toThrow();
      expect(readFileSync(path, "utf8")).toBe('{"schemaVersion":2}');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
