import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { buildV9EvidenceGapQueue } from "@shared/lib/safety-score-v9/evidence-gap-queue";
import { loadV9MethodologyPolicy } from "@shared/lib/safety-score-v9/policy";
import { V9EvidenceGapQueueV2Schema, type V9EvidenceGapQueueV2 } from "@shared/types/safety-score-v9-evidence-queue";
import { assertCliUsage, parseStrictCliArgs, runCliEntrypoint, writeCliHelpIfRequested } from "../lib/cli-args.mjs";

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
  writeText: (path, contents) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf8");
  },
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
  assertCliUsage(typeof values["fact-set"] === "string", "--fact-set is required");
  assertCliUsage(typeof values.policy === "string", "--policy is required");
  assertCliUsage(typeof values.output === "string", "--output is required");

  const queue = generateV9EvidenceGapQueueFromArtifacts({
    factSet: io.readJson(values["fact-set"]),
    policy: io.readJson(values.policy),
  });
  io.writeText(values.output, `${JSON.stringify(queue, null, 2)}\n`);
  if (values["require-clear"] === true && queue.status !== "clear") {
    throw new Error(`Safety Score v9 evidence queue contains ${queue.summary.gapCount} gap(s)`);
  }
  return queue;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCliEntrypoint(() => runV9EvidenceGapQueueCli(process.argv.slice(2)), {
    label: "safety-score-v9:evidence-gaps",
    usage: USAGE,
  });
}
