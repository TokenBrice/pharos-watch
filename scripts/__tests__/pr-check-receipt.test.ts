import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeReceiptOutcome, firstActionableError, writePrCheckReceipt, type PrCheckReceiptLeaf } from "../lib/pr-check-receipt.mts";

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
