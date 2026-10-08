import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

export interface PrCheckReceiptLeaf {
  id: string;
  command: string;
  status: "passed" | "failed" | "skipped" | "not-selected";
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
    status: z.enum(["passed", "failed", "skipped", "not-selected"]),
    durationMs: z.number().nonnegative(),
    firstError: z.string().optional(),
  })),
  outcome: z.enum(["passed", "failed", "incomplete"]),
});

/** Version 1 remains readable; tested-merge identity is additive and optional. */
export function readPrCheckReceipt(path: string): PrCheckReceipt {
  return ReceiptSchema.parse(JSON.parse(readFileSync(path, "utf8")));
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
