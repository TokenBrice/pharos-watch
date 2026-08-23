import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SafetyScoreV9ResponseSchema } from "@shared/types/safety-score-v9-public";
import { z } from "zod";
import {
  assertCliUsage,
  parseStrictCliArgs,
  runCliEntrypoint,
  writeCliHelpIfRequested,
} from "../../scripts/lib/cli-args.mjs";
import {
  evaluateSafetyScoreV9AnchorGate,
  type V9AnchorGateCard,
  type V9AnchorGateReport,
} from "./lib/safety-score-v9-anchor-gate";

const USAGE = `Usage: npm run safety-score-v9:anchor-gate -- --replay <path> [options]

Options:
  --replay <path>        V9 replay artifact JSON (required)
  --apply-ruling <id>    Apply a pending owner ruling (e.g. D-F, D-G); repeatable
  -h, --help             Show this help`;

const ReplayArtifactInputSchema = z
  .object({
    kind: z.literal("safety-score-v9-candidate-replay"),
    pipeline: z
      .object({
        candidate: z.unknown(),
        compiledFacts: z
          .object({
            assets: z
              .array(z.object({ assetId: z.string().min(1), archetype: z.string().min(1) }).passthrough())
              .min(1),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

/** Projects a replay artifact's V9 cards joined with compiled-fact archetypes. */
export function parseSafetyScoreV9AnchorGateCards(input: unknown): V9AnchorGateCard[] {
  const artifact = ReplayArtifactInputSchema.parse(input);
  const candidate = SafetyScoreV9ResponseSchema.parse(artifact.pipeline.candidate);
  const archetypeById = new Map(
    artifact.pipeline.compiledFacts.assets.map((asset) => [asset.assetId, asset.archetype]),
  );
  return candidate.cards.map((card) => {
    const archetype = archetypeById.get(card.id);
    if (archetype === undefined) {
      throw new Error(`Anchor gate card ${card.id} has no compiled-facts archetype entry`);
    }
    return { id: card.id, score: card.score, grade: card.grade, archetype };
  });
}

/**
 * Publication clock the replayed cards were scored at. Time-boxed anchors are
 * resolved against this rather than wall-clock `now`, so replaying an old
 * capture judges it under the contract that was live at its own publication.
 */
export function parseSafetyScoreV9AnchorGateAsOfSec(input: unknown): number {
  const artifact = ReplayArtifactInputSchema.parse(input);
  return SafetyScoreV9ResponseSchema.parse(artifact.pipeline.candidate).publishedAtSec;
}

export interface SafetyScoreV9AnchorGateIo {
  readJson(path: string): unknown;
  stdout: { write(text: string): unknown };
}

const DEFAULT_IO: SafetyScoreV9AnchorGateIo = {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- explicit local operator input path.
  readJson: (path) => JSON.parse(readFileSync(path, "utf8")) as unknown,
  stdout: process.stdout,
};

export async function runSafetyScoreV9AnchorGateCli(
  argv: readonly string[],
  io: SafetyScoreV9AnchorGateIo = DEFAULT_IO,
): Promise<V9AnchorGateReport | null> {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      replay: { type: "string" },
      "apply-ruling": { type: "string", multiple: true },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE, io.stdout)) return null;
  assertCliUsage(typeof values.replay === "string", "--replay is required");

  const artifact = io.readJson(values.replay);
  const cards = parseSafetyScoreV9AnchorGateCards(artifact);
  const asOfSec = parseSafetyScoreV9AnchorGateAsOfSec(artifact);
  const applyRulings = Array.isArray(values["apply-ruling"])
    ? (values["apply-ruling"] as string[])
    : [];
  const report = evaluateSafetyScoreV9AnchorGate({ cards, applyRulings, asOfSec });
  io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.decision !== "gate-passed") {
    const failed = report.verdicts.filter((verdict) => verdict.status === "fail").length;
    throw new Error(`Safety Score v9 anchor gate is no-go (${failed} failed rule(s))`);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCliEntrypoint(() => runSafetyScoreV9AnchorGateCli(process.argv.slice(2)), {
    label: "safety-score-v9:anchor-gate",
    usage: USAGE,
  });
}
