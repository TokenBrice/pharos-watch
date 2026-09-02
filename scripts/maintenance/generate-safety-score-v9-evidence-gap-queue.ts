import { buildV9EvidenceGapQueue } from "@shared/lib/safety-score-v9/evidence-gap-queue";
import { loadV9MethodologyPolicy } from "@shared/lib/safety-score-v9/policy";
import { V9EvidenceGapQueueV2Schema, type V9EvidenceGapQueueV2 } from "@shared/types/safety-score-v9-evidence-queue";
import {
  requireCliString,
  runDirectCli,
} from "../lib/cli-args.mjs";
import {
  createDefaultReportCliIo,
  runOperationalQueueCli,
  type ReportCliIo,
} from "../lib/report-cli";

const USAGE = `Usage: npx tsx scripts/maintenance/generate-safety-score-v9-evidence-gap-queue.ts [options]

Options:
  --fact-set <path>       Compiled V3 or retained V2 fact-set JSON (required)
  --policy <path>         Explicit V9 methodology policy JSON (required)
  --output <path>         Strict evidence-gap queue JSON (required)
  --require-clear         Exit nonzero after writing when work remains
  -h, --help              Show this help`;

export type V9EvidenceGapQueueIo = ReportCliIo;

const DEFAULT_IO = createDefaultReportCliIo();

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
  return runOperationalQueueCli({
    argv,
    io,
    usage: USAGE,
    options: {
      "fact-set": { type: "string" },
      policy: { type: "string" },
    },
    buildQueue(values) {
      const factSetPath = requireCliString(values["fact-set"], "--fact-set");
      const policyPath = requireCliString(values.policy, "--policy");
      return generateV9EvidenceGapQueueFromArtifacts({
        factSet: io.readJson(factSetPath),
        policy: io.readJson(policyPath),
      });
    },
    isClear: (queue) => queue.status === "clear",
    failureMessage: (queue) => `Safety Score v9 evidence queue contains ${queue.summary.gapCount} gap(s)`,
  });
}

runDirectCli(import.meta.url, () => runV9EvidenceGapQueueCli(process.argv.slice(2)), {
  label: "safety-score-v9:evidence-gaps",
  usage: USAGE,
});
