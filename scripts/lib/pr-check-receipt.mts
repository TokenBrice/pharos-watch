import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

export interface PrCheckReceiptLeaf {
  id: string;
  command: string;
  /** `deferred-to-ci`: selected, but owned by the GitHub PR gate unless opted in locally. */
  status: "passed" | "failed" | "skipped" | "not-selected" | "deferred-to-ci";
  durationMs: number;
  firstError?: string;
}

export interface PrCheckReceipt {
  schemaVersion: 1;
  node: string;
  npm: string;
  baseSha: string;
  headSha: string;
  /** Opt-in clean-clone proof; headSha remains the author's branch identity. */
  mode?: "ci-parity";
  mergeSha?: string;
  mergeTree?: string;
  treeClean: boolean;
  flags: Record<string, unknown>;
  weakened: boolean;
  incompleteReasons?: string[];
  startedAt: string;
  finishedAt: string;
  leaves: PrCheckReceiptLeaf[];
  outcome: "passed" | "failed" | "incomplete";
}

const ReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  node: z.string(),
  npm: z.string(),
  baseSha: z.string(),
  headSha: z.string().regex(/^[a-f0-9]{40,64}$/),
  mode: z.literal("ci-parity").optional(),
  mergeSha: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
  mergeTree: z.union([z.literal(""), z.string().regex(/^[a-f0-9]{40,64}$/)]).optional(),
  treeClean: z.boolean(),
  flags: z.record(z.string(), z.unknown()),
  weakened: z.boolean(),
  incompleteReasons: z.array(z.string()).optional(),
  startedAt: z.string(),
  finishedAt: z.string(),
  leaves: z.array(z.object({
    id: z.string(),
    command: z.string(),
    status: z.enum(["passed", "failed", "skipped", "not-selected", "deferred-to-ci"]),
    durationMs: z.number().nonnegative(),
    firstError: z.string().optional(),
  })),
  outcome: z.enum(["passed", "failed", "incomplete"]),
});

/** Version 1 remains readable; tested-merge identity is additive and optional. */
export function readPrCheckReceipt(path: string): PrCheckReceipt {
  return ReceiptSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export interface PrReceiptCheckout {
  headSha: string;
  treeClean: boolean;
  baseRef: string;
  localBaseSha?: string;
}

/** Explain historical evidence, never certify current readiness or push authority. */
export function explainPrCheckReceipt(checkout: PrReceiptCheckout, repoRoot = process.cwd()): string {
  const path = resolve(repoRoot, ".tmp/pr-check-receipts", `${checkout.headSha}.json`);
  let receipt: PrCheckReceipt;
  try {
    receipt = readPrCheckReceipt(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [
      `Receipt: missing (${path})`,
      `Current HEAD: ${checkout.headSha}; tree: ${checkout.treeClean ? "clean" : "dirty"}`,
      "Remote-base freshness: unknown (no remote observation; no fetch performed).",
      "Next action: follow docs/testing.md#pre-push-readiness on the final committed clean HEAD: converge npm run check:generated-artifacts, then run plain npm run check:pr.",
      "Read-only explanation: no checks executed or receipt written; no push authorization. Exit 0 means explanation completed, not readiness.",
    ].join("\n");
  }

  const limitations: string[] = [];
  if (receipt.headSha !== checkout.headSha) limitations.push("HEAD mismatch: receipt belongs to a different commit.");
  if (!checkout.treeClean) limitations.push("Current dirty tree: edits are outside the committed-HEAD proof.");
  if (!receipt.treeClean) limitations.push("Recorded dirty tree: this run was not committed-HEAD readiness proof.");
  if (receipt.weakened) limitations.push("Recorded weakened invocation: not readiness proof.");
  if (receipt.outcome === "incomplete") limitations.push("Recorded incomplete outcome: not readiness proof.");
  if (receipt.incompleteReasons?.length) limitations.push(`Recorded incomplete reasons: ${receipt.incompleteReasons.join(", ")}.`);
  const flags = receipt.flags;
  const nonPlain = receipt.mode === "ci-parity" || flags.noFetch === true || flags.noFetchEnv === true
    || flags.plan === true || flags.withCoverage === true || flags.withPages === true
    || (Array.isArray(flags.forwardedTestArgs) && flags.forwardedTestArgs.length > 0);
  if (nonPlain) limitations.push("Recorded mode/flags are not final plain readiness; parity and opt-in lanes do not replace the final plain run.");
  const baseDiffers = checkout.localBaseSha !== undefined && checkout.localBaseSha !== receipt.baseSha;
  if (baseDiffers) limitations.push("Recorded base differs from the locally available base; reconcile the intended base before reusing this evidence.");
  if (checkout.localBaseSha === undefined) limitations.push(`Local base ${checkout.baseRef} is unavailable; base identity cannot be compared.`);
  const failed = receipt.leaves.filter((leaf) => leaf.status === "failed");
  const skipped = receipt.leaves.some((leaf) => leaf.status === "skipped");
  if (skipped) limitations.push("Skipped lanes: selected checks were not completely executed.");
  const deferred = receipt.leaves.filter((leaf) => leaf.status === "deferred-to-ci");
  const rerun = "follow docs/testing.md#pre-push-readiness on the final committed clean HEAD: converge npm run check:generated-artifacts, then run plain npm run check:pr.";
  let nextAction: string;
  if (failed.length || receipt.outcome === "failed") {
    nextAction = `Fix every failed lane${failed.length ? ` (${failed.map((leaf) => leaf.id).join(", ")})` : ""}, then ${rerun}`;
  } else if (receipt.headSha !== checkout.headSha || !checkout.treeClean || !receipt.treeClean
    || receipt.weakened || receipt.outcome === "incomplete" || nonPlain || baseDiffers || skipped) {
    nextAction = `Resolve the limitations above, then ${rerun}`;
  } else {
    nextAction = "Verify the latest remote base separately under docs/testing.md#pre-push-readiness; retain this receipt only if HEAD, clean tree and base remain unchanged. If the base or checkout changed, repeat generated convergence and plain npm run check:pr.";
  }
  if (deferred.length) nextAction += ` GitHub must still pass the deferred lanes (${deferred.map((leaf) => leaf.id).join(", ")}); deferred-to-ci is not a local failure.`;
  return [
    `Receipt: ${path}`,
    `Recorded HEAD: ${receipt.headSha}`,
    `Recorded base: ${receipt.baseSha || "(unresolved)"}`,
    `Recorded runtime: Node ${receipt.node}; npm ${receipt.npm}`,
    `Recorded mode: ${receipt.mode ?? "plain"}; flags: ${JSON.stringify(receipt.flags)}`,
    `Recorded tree: ${receipt.treeClean ? "clean" : "dirty"}; weakened: ${receipt.weakened}; outcome: ${receipt.outcome}`,
    `Recorded time: ${receipt.startedAt} -> ${receipt.finishedAt}`,
    ...(receipt.mode === "ci-parity" ? [`Recorded tested merge: ${receipt.mergeSha ?? "(unavailable)"}; tree: ${receipt.mergeTree || "(unavailable)"}`] : []),
    `Current HEAD: ${checkout.headSha}; tree: ${checkout.treeClean ? "clean" : "dirty"}`,
    `Local base ${checkout.baseRef}: ${checkout.localBaseSha ?? "(unavailable)"} (local comparison only; original base ref is not recorded)`,
    "Lane outcomes (status | id | milliseconds | command | first actionable error):",
    ...receipt.leaves.map((leaf) => `${leaf.status} | ${leaf.id} | ${leaf.durationMs} | ${leaf.command}${leaf.firstError ? ` | ${leaf.firstError}` : ""}`),
    "Freshness limitations:",
    ...(limitations.length ? limitations.map((limitation) => `- ${limitation}`) : ["- Recorded HEAD and clean tree match the current checkout; no local invalidation observed."]),
    "- Remote-base freshness: unknown (the receipt has no current remote observation; matching a cached ref is not proof; no fetch performed).",
    "- A clean tree cannot establish that no edits occurred since the recorded run.",
    `Next action: ${nextAction}`,
    "Read-only explanation: no checks executed or receipt written; no push authorization. Exit 0 means explanation completed, not readiness.",
  ].join("\n");
}

export function computeReceiptOutcome(
  leaves: readonly PrCheckReceiptLeaf[],
  weakened: boolean,
): PrCheckReceipt["outcome"] {
  // A failed proof is never concealed by a bypass; otherwise bypasses cannot
  // certify readiness, even when every executed command succeeded.
  if (leaves.some((leaf) => leaf.status === "failed")) return "failed";
  if (weakened || leaves.some((leaf) => leaf.status === "skipped")) return "incomplete";
  return "passed";
}

export function firstActionableError(output: string | undefined, fallback: string): string {
  const lines = (output ?? "").replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /error|fail|exception|cannot|could not|ENOENT|violation|✖|×|❯/i.test(line) && !/^npm (?:error|ERR!) (?:Lifecycle|command failed)/i.test(line))
    ?? lines.find((line) => !/^(?:>|npm (?:warn|notice)|\[check:)/.test(line))
    ?? fallback;
}

export function writePrCheckReceipt(receipt: PrCheckReceipt, repoRoot = process.cwd()): string {
  if (!/^[a-f0-9]{40,64}$/.test(receipt.headSha)) throw new Error("Cannot write a receipt without a resolved HEAD SHA.");
  const path = resolve(repoRoot, ".tmp/pr-check-receipts", `${receipt.headSha}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
  return path;
}
