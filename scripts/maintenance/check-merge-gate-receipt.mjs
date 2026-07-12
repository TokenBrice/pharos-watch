#!/usr/bin/env node
import { checkMergeGateReceipt } from "../lib/merge-gate-receipt.mjs";

const result = checkMergeGateReceipt({
  baseRef: process.env.MERGE_GATE_BASE_REF ?? "origin/main",
  env: process.env,
  fullDeploy: process.env.MERGE_GATE_FULL_DEPLOY === "1",
  headRef: process.env.MERGE_GATE_HEAD_REF ?? "HEAD",
  maxAgeMs: Number.parseInt(process.env.MERGE_GATE_RECEIPT_MAX_AGE_MS ?? "", 10) || undefined,
});

console.log(`[merge-gate] Receipt ${result.valid ? "accepted" : "not reusable"}: ${result.reason}.`);
process.exit(result.valid ? 0 : 1);
