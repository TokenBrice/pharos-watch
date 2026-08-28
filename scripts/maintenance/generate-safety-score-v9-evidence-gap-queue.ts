import { readFileSync } from "node:fs";
import { buildV9EvidenceGapQueue } from "@shared/lib/safety-score-v9/evidence-gap-queue";
import { loadV9MethodologyPolicy } from "@shared/lib/safety-score-v9/policy";
import { V9EvidenceGapQueueV2Schema, type V9EvidenceGapQueueV2 } from "@shared/types/safety-score-v9-evidence-queue";
import {
  parseStrictCliArgs,
  requireCliString,
  runDirectCli,
  writeCliHelpIfRequested,
  writeJsonOutput,
} from "../lib/cli-args.mjs";

const USAGE = `Usage: npx tsx scripts/maintenance/generate-safety-score-v9-evidence-gap-queue.ts [options]

Options:
  --fact-set <path>       Compiled V3 or retained V2 fact-set JSON (required)
  --policy <path>         Explicit V9 methodology policy JSON (required)
  --output <path>         Strict evidence-gap queue JSON (required)
  --require-clear         Exit nonzero after writing when work remains
  -h, --help              Show this help`;

export interface V9EvidenceGapQueueIo {
  readJson(path: string): unknown;
  writeText(path: string, contents: string): void;
  stdout: { write(text: string): unknown };
}

const DEFAULT_IO: V9EvidenceGapQueueIo = {
  readJson: (path) => JSON.parse(readFileSync(path, "utf8")) as unknown,
  writeText: writeJsonOutput,
  stdout: process.stdout,
};

export function generateV9EvidenceGapQueueFromArtifacts(input: {
  factSet: unknown;
  policy: unknown;
}): V9EvidenceGapQueueV2 {
  return V9EvidenceGapQueueV2Schema.parse(
    buildV9EvidenceGapQueue({
      factSet: input.factSet,
      policy: loadV9MethodologyPolicy(input.policy),
    }),
  );
}

export function runV9EvidenceGapQueueCli(
  argv: readonly string[],
  io: V9EvidenceGapQueueIo = DEFAULT_IO,
): V9EvidenceGapQueueV2 | null {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      "fact-set": { type: "string" },
      policy: { type: "string" },
      output: { type: "string" },
      "require-clear": { type: "boolean" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE, io.stdout)) return null;
  const factSetPath = requireCliString(values["fact-set"], "--fact-set");
  const policyPath = requireCliString(values.policy, "--policy");
  const outputPath = requireCliString(values.output, "--output");

  const queue = generateV9EvidenceGapQueueFromArtifacts({
    factSet: io.readJson(factSetPath),
    policy: io.readJson(policyPath),
  });
  io.writeText(outputPath, `${JSON.stringify(queue, null, 2)}\n`);
  if (values["require-clear"] === true && queue.status !== "clear") {
    throw new Error(`Safety Score v9 evidence queue contains ${queue.summary.gapCount} gap(s)`);
  }
  return queue;
}

runDirectCli(import.meta.url, () => runV9EvidenceGapQueueCli(process.argv.slice(2)), {
  label: "safety-score-v9:evidence-gaps",
  usage: USAGE,
});
