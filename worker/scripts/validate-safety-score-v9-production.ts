import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  V9ProductionSourceReceipt,
  V9StrictProductionAcceptanceReport,
} from "@shared/types/safety-score-v9-production-validation";
import {
  evaluateV9StrictProductionAcceptance,
  type V9ProductionGenerationVerificationInput,
} from "../src/lib/safety-score-v9-production-verifier";
import {
  assertCliUsage,
  parseStrictCliArgs,
  runCliEntrypoint,
  writeCliHelpIfRequested,
} from "../../scripts/lib/cli-args.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const USAGE = `Usage: npm run safety-score-v9:production-validation -- [options]

Options:
  --generation <path>       Candidate replay JSON; repeat in chronological capture order (required)
  --exact-cache <path>      Raw production exact-cache D1 export paired by position with --generation
  --capture-ledger <path>   Complete/failed capture ledger for continuity proof
  --holdout-input <path>    Sealed blind holdout evaluation input
  --holdout-report <path>   Expected report, locally recomputed from --holdout-input
  --holdout-scorer-proof <path>
                            Frozen per-case production scorer inputs for local recomputation
  --output <path>           Strict production acceptance report JSON (required)
  -h, --help                Show this help

Missing exact caches, capture ledger, holdout input/report pair, or machine-derived validation
proofs produce a structured no-go report; reviewer-authored pass booleans are not accepted.`;

export interface V9ProductionValidationIo {
  readJson(path: string): unknown;
  writeText(path: string, contents: string): void;
  sourceReceipt(): V9ProductionSourceReceipt;
  stdout: { write(text: string): unknown };
}

function gitText(args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
}

function localSourceReceipt(): V9ProductionSourceReceipt {
  const expectedNode = readFileSync(resolve(REPO_ROOT, ".nvmrc"), "utf8").trim();
  return {
    sourceCommit: gitText(["rev-parse", "HEAD"]),
    branch: gitText(["branch", "--show-current"]),
    runtimeVersion: process.version,
    expectedRuntimeVersion: expectedNode.startsWith("v") ? expectedNode : `v${expectedNode}`,
    trackedWorktreeClean: gitText(["status", "--porcelain", "--untracked-files=normal"]).length === 0,
    validatedAtSec: Math.floor(Date.now() / 1_000),
  };
}

const DEFAULT_IO: V9ProductionValidationIo = {
  readJson: (path) => JSON.parse(readFileSync(path, "utf8")) as unknown,
  writeText: (path, contents) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf8");
  },
  sourceReceipt: localSourceReceipt,
  stdout: process.stdout,
};

export async function runV9ProductionValidationCli(
  argv: readonly string[],
  io: V9ProductionValidationIo = DEFAULT_IO,
): Promise<V9StrictProductionAcceptanceReport | null> {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      generation: { type: "string", multiple: true },
      "exact-cache": { type: "string", multiple: true },
      "capture-ledger": { type: "string" },
      "holdout-input": { type: "string" },
      "holdout-report": { type: "string" },
      "holdout-scorer-proof": { type: "string" },
      output: { type: "string" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE, io.stdout)) return null;
  assertCliUsage(Array.isArray(values.generation) && values.generation.length > 0, "--generation is required");
  assertCliUsage(typeof values.output === "string", "--output is required");

  const generationPaths = values.generation as string[];
  const exactCachePaths = Array.isArray(values["exact-cache"])
    ? (values["exact-cache"] as string[])
    : [];
  const generationCount = Math.max(generationPaths.length, exactCachePaths.length);
  const generations: V9ProductionGenerationVerificationInput[] = Array.from(
    { length: generationCount },
    (_, index) => ({
      replay:
        generationPaths[index] === undefined
          ? undefined
          : io.readJson(generationPaths[index]!),
      exactCache:
        exactCachePaths[index] === undefined
          ? undefined
          : io.readJson(exactCachePaths[index]!),
    }),
  );
  const report = await evaluateV9StrictProductionAcceptance({
    generations,
    ...(typeof values["capture-ledger"] === "string"
      ? { captureLedger: io.readJson(values["capture-ledger"]) }
      : {}),
    ...(typeof values["holdout-input"] === "string"
      ? { holdoutInput: io.readJson(values["holdout-input"]) }
      : {}),
    ...(typeof values["holdout-report"] === "string"
      ? { holdoutReport: io.readJson(values["holdout-report"]) }
      : {}),
    ...(typeof values["holdout-scorer-proof"] === "string"
      ? { holdoutScorerProof: io.readJson(values["holdout-scorer-proof"]) }
      : {}),
    source: io.sourceReceipt(),
  });
  io.writeText(values.output, `${JSON.stringify(report, null, 2)}\n`);
  io.stdout.write(
    `Safety Score v9 strict production acceptance: ${report.decision} ` +
      `(${report.generationVerifications.length} generation input(s), ` +
      `${report.noGoReasons.length} no-go reason(s))\n`,
  );
  if (report.decision !== "gate-passed") {
    throw new Error(
      `Safety Score v9 strict production acceptance is no-go: ${report.noGoReasons.join(", ")}`,
    );
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCliEntrypoint(() => runV9ProductionValidationCli(process.argv.slice(2)), {
    label: "safety-score-v9:production-validation",
    usage: USAGE,
  });
}
