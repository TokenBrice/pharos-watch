import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { REPORT_CARD_GRADE_RANK } from "@shared/lib/report-card-core";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { V9Grade } from "@shared/types/safety-score-v9";
import { V9GradeSchema } from "@shared/types/safety-score-v9";
import { V9RatingStatusSchema } from "@shared/types/safety-score-v9-causes";
import { V9AccessClaimGraphSchema } from "@shared/types/safety-score-v9-access-lookthrough";
import type { SafetyScoreV9FactSetExtensionV2 } from "../src/lib/safety-score-v9/fact-set";
import {
  buildSafetyScoreV9BaselineExtension,
  type V9ExtensionRegistryMeta,
} from "../src/lib/safety-score-v9/extension";
import {
  buildSafetyScoreV9Candidate,
  type SafetyScoreV9CandidatePipelineResult,
} from "../src/lib/safety-score-v9/candidate";
import {
  computeNativeDexLiquidityPayloadFingerprint,
  normalizeSafetyScoreV9CompilerInput,
  type SafetyScoreV9CompilerInput,
} from "../src/lib/safety-score-v9/native-input";
import {
  assertCliUsage,
  parseStrictCliArgs,
  runCliEntrypoint,
  writeCliHelpIfRequested,
} from "../../scripts/lib/cli-args.mjs";

const USAGE = `Usage: npm run safety-score-v9:live-withheld -- --replay <path> [--output <path>]`;

const ReplaySchema = z
  .object({
    pipeline: z
      .object({
        fixedInput: z
          .object({
            activeAssetIds: z.array(z.string()),
            baseInputGenerationId: z.string(),
            clockSec: z.number().int().nonnegative(),
            liveReserveMap: z.record(z.string(), z.array(z.unknown())),
            liveReserveProvenanceMap: z
              .record(
                z.string(),
                z.object({ source: z.string().min(1), fetchedAt: z.number().int().nonnegative() }).loose(),
              )
              .default({}),
            liveToFallbackCoins: z.array(z.string()).default([]),
          })
          .loose(),
        candidate: z
          .object({
            publishedAtSec: z.number().int().nonnegative(),
            cards: z.array(
              z
                .object({
                  id: z.string(),
                  score: z.number().finite().nullable(),
                  grade: V9GradeSchema.nullable(),
                  ratingStatus: V9RatingStatusSchema,
                  bindingCap: z
                    .object({ kind: z.string() })
                    .loose()
                    .nullable()
                    .optional(),
                })
                .loose(),
            ),
          })
          .loose(),
        evaluatedSet: z
          .object({
            assets: z.array(
              z
                .object({
                  assetId: z.string(),
                  stressState: z
                    .object({
                      exitPortfolio: z
                        .object({ circulatingUsd: z.number().finite().nullable().optional() })
                        .loose()
                        .optional(),
                    })
                    .loose()
                    .optional(),
                })
                .loose(),
            ),
          })
          .loose(),
      })
      .loose(),
  })
  .loose();

type Replay = z.infer<typeof ReplaySchema>;
type ReplayFixedInput = Replay["pipeline"]["fixedInput"];
type ReplayCard = Replay["pipeline"]["candidate"]["cards"][number];
type FallbackTier = "static" | "audited-fallback" | "curated-fallback" | "none";

export interface LiveWithheldRow {
  assetId: string;
  supplyUsd: number | null;
  supplyAvailability: "observed" | "unavailable";
  supplyUnavailableReason: "null-supply" | "missing-supply" | null;
  liveScore: number | null;
  liveGrade: V9Grade;
  fallbackScore: number | null;
  fallbackGrade: V9Grade;
  fallbackTier: FallbackTier;
  fallbackEvidenceCeiling: number | null;
  fallbackBindingCapKind: string | null;
}

export interface LiveWithheldReport {
  clockSec: number;
  rows: LiveWithheldRow[];
  assessedCount: number;
  excludedCounts: Record<"no-live" | "already-fallback" | "baseline-pipeline-gap" | "fallback-pipeline-gap" | "unchanged-or-upgrade", number>;
}

function cardForAsset(cards: readonly ReplayCard[], assetId: string): ReplayCard {
  const card = cards.find((candidate) => candidate.id === assetId);
  if (!card) throw new Error(`Replay candidate has no card for active asset ${assetId}`);
  return card;
}

function fallbackTier(
  admitted: SafetyScoreV9CandidatePipelineResult["extension"]["assets"][number]["reviewedStaticReserveRows"],
): { tier: FallbackTier; evidenceCeiling: number | null } {
  if (admitted == null) return { tier: "none", evidenceCeiling: null };
  const evidenceCeiling =
    admitted.evidenceClass === "independent"
      ? null
      : V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.ceilings.adequate;
  return {
    tier: admitted.provenance === "audited-fallback" ? "audited-fallback" : admitted.provenance === "curated-fallback" ? "curated-fallback" : "static",
    evidenceCeiling,
  };
}

function withLiveReserveWithheld(
  fixedInputValue: ReplayFixedInput,
  assetId: string,
): SafetyScoreV9CompilerInput {
  const draft = structuredClone(normalizeSafetyScoreV9CompilerInput(fixedInputValue)) as Record<string, unknown> & {
    liveReserveMap: Record<string, unknown>;
    liveReserveProvenanceMap: Record<string, unknown>;
    liveToFallbackCoins: string[];
  };
  delete draft.liveReserveMap[assetId];
  delete draft.liveReserveProvenanceMap[assetId];
  if (!draft.liveToFallbackCoins.includes(assetId)) draft.liveToFallbackCoins.push(assetId);
  // Never reseal the identity by hand. `normalizeNativeV9Input` /
  // `normalizeFixedInput` derive the base generation id when none is supplied
  // and verify it when one is, and they canonicalize record ordering first.
  // Deriving it here instead produced a digest over the pre-canonical payload,
  // so the compiler's own re-derivation disagreed and every real capture failed.
  delete draft.baseInputGenerationId;
  return normalizeSafetyScoreV9CompilerInput(draft);
}

/** Static admitted reviews are unchanged by withholding a reserve observation. */
export function readmitCounterfactualAccessGraph(
  graphValue: unknown,
  sourceInput: { clockSec: number; baseInputGenerationId: string },
  counterfactualInput: { clockSec: number; baseInputGenerationId: string },
) {
  const graph = V9AccessClaimGraphSchema.parse(graphValue);
  if (graph.clockSec !== sourceInput.clockSec || graph.generationId !== sourceInput.baseInputGenerationId ||
      counterfactualInput.clockSec !== sourceInput.clockSec) {
    throw new Error("Access graph must match the admitted clock and input generation");
  }
  // The builder derives these static nodes/statuses solely from the review and
  // clock. Reserve-dependent shares are evaluated later against the new facts.
  // Re-validate the entire graph; final fact-set admission still validates every
  // status/evidence reference against the full new input generation.
  return V9AccessClaimGraphSchema.parse({ ...graph, generationId: counterfactualInput.baseInputGenerationId });
}

export function buildCounterfactualPipeline(
  replay: Replay,
  fixedInput: SafetyScoreV9CompilerInput,
  assetId: string,
  metaById: ReadonlyMap<string, V9ExtensionRegistryMeta>,
): SafetyScoreV9CandidatePipelineResult {
  const replayExtension = (replay.pipeline as unknown as { extension?: unknown }).extension;
  let extension: unknown;
  if (replayExtension === undefined) {
    extension = buildSafetyScoreV9BaselineExtension(fixedInput, {
      allowRegistryMismatch: true,
      metaById,
    });
  } else {
    const original = structuredClone(replayExtension) as SafetyScoreV9FactSetExtensionV2;
    if (!Array.isArray(original.assets)) throw new Error("Replay extension has no asset set");
    let rebuiltFixedInput = fixedInput;
    const hasGraphs = original.assets.some((asset) => asset.accessReview?.freeze.claimGraph !== undefined);
    if (fixedInput.captureKind === "native-v9-inputs" && !hasGraphs) {
      const narrowFixedInput = structuredClone(fixedInput) as SafetyScoreV9CompilerInput & {
        activeAssetIds: string[];
      };
      narrowFixedInput.activeAssetIds = [assetId];
      narrowFixedInput.dexLiqMap = { [assetId]: fixedInput.dexLiqMap[assetId]! };
      narrowFixedInput.dexPayloadFingerprint = computeNativeDexLiquidityPayloadFingerprint(
        narrowFixedInput.dexLiqMap,
        narrowFixedInput.dexGenerationId,
      );
      delete (narrowFixedInput as { baseInputGenerationId?: string }).baseInputGenerationId;
      rebuiltFixedInput = narrowFixedInput;
    }
    const rebuilt = buildSafetyScoreV9BaselineExtension(rebuiltFixedInput, {
      allowRegistryMismatch: true,
      metaById,
    });
    const target = rebuilt.assets.find((asset) => asset.assetId === assetId);
    if (!target) {
      throw new Error(`Counterfactual extension rebuild did not produce ${assetId}`);
    }
    original.assets = original.assets.map((asset) => {
      let next = asset.assetId === assetId ? target : asset;
      const graph = asset.accessReview?.freeze.claimGraph;
      if (graph === undefined) return next;
      const admitted = readmitCounterfactualAccessGraph(graph, replay.pipeline.fixedInput, fixedInput);
      if (next === target) {
        next = structuredClone(target);
        // Keep captured access overlays and their evidence, not today's review
        // registry, while rebuilding the target's reserve-dependent facts.
        next.accessReview = structuredClone(asset.accessReview);
        const evidenceByKey = new Map(next.researchEvidence.map((entry) => [entry.evidenceKey, entry]));
        for (const entry of asset.researchEvidence) evidenceByKey.set(entry.evidenceKey, entry);
        next.researchEvidence = [...evidenceByKey.values()];
        next.componentEvidence = [
          ...next.componentEvidence.filter((entry) => !entry.componentKey.startsWith("access:")),
          ...asset.componentEvidence.filter((entry) => entry.componentKey.startsWith("access:")),
        ];
      }
      next.accessReview!.freeze.claimGraph = admitted;
      return next;
    });
    extension = original;
  }
  return buildSafetyScoreV9Candidate({
    fixedInput,
    extension,
    publishedAtSec: replay.pipeline.candidate.publishedAtSec,
  });
}

function supplyByAssetId(replay: Replay): ReadonlyMap<string, Pick<LiveWithheldRow, "supplyUsd" | "supplyAvailability" | "supplyUnavailableReason">> {
  return new Map<string, Pick<LiveWithheldRow, "supplyUsd" | "supplyAvailability" | "supplyUnavailableReason">>(replay.pipeline.evaluatedSet.assets.map(asset => {
    const supply = asset.stressState?.exitPortfolio?.circulatingUsd;
    return [asset.assetId, {
      supplyUsd: supply ?? null,
      supplyAvailability: supply == null ? "unavailable" : "observed",
      supplyUnavailableReason: supply === null ? "null-supply" : supply === undefined ? "missing-supply" : null,
    }];
  }));
}

/**
 * Replays one isolated producer-withheld capture per live-backed asset. A
 * single all-assets transform would let a fallback score inherit unrelated
 * dependency changes, so each pass removes only the selected producer while
 * leaving every other live snapshot untouched.
 */
export function buildLiveWithheldCounterfactualReport(
  replayValue: Replay,
  metaById: ReadonlyMap<string, V9ExtensionRegistryMeta> = ACTIVE_META_BY_ID,
): LiveWithheldReport {
  const replay = ReplaySchema.parse(replayValue);
  const { fixedInput, candidate } = replay.pipeline;
  const alreadyFallback = new Set(fixedInput.liveToFallbackCoins);
  const supplies = supplyByAssetId(replay);
  const rows: LiveWithheldRow[] = [];
  const excludedCounts: LiveWithheldReport["excludedCounts"] = {
    "no-live": 0, "already-fallback": 0, "baseline-pipeline-gap": 0,
    "fallback-pipeline-gap": 0, "unchanged-or-upgrade": 0,
  };
  let assessedCount = 0;

  for (const assetId of fixedInput.activeAssetIds) {
    const meta = metaById.get(assetId);
    if (!meta) throw new Error(`Replay active asset ${assetId} is missing registry metadata`);
    const liveRows = fixedInput.liveReserveMap[assetId];
    if (alreadyFallback.has(assetId)) { excludedCounts["already-fallback"]++; continue; }
    if (meta.liveReservesConfig == null || liveRows === undefined || liveRows.length === 0) {
      excludedCounts["no-live"]++;
      continue;
    }

    const liveCard = cardForAsset(candidate.cards, assetId);
    if (liveCard.ratingStatus === "pipeline-gap" || liveCard.grade === null) {
      excludedCounts["baseline-pipeline-gap"]++;
      continue;
    }
    const counterfactual = buildCounterfactualPipeline(
      replay,
      withLiveReserveWithheld(fixedInput, assetId),
      assetId,
      metaById,
    );
    const fallbackCard = counterfactual.candidate.cards.find((card) => card.id === assetId);
    if (!fallbackCard) throw new Error(`Counterfactual candidate has no card for active asset ${assetId}`);
    if (fallbackCard.ratingStatus === "pipeline-gap" || fallbackCard.grade === null) {
      excludedCounts["fallback-pipeline-gap"]++;
      continue;
    }
    assessedCount++;
    const extensionAsset = counterfactual.extension.assets.find((asset) => asset.assetId === assetId);
    const admission = fallbackTier(extensionAsset?.reviewedStaticReserveRows ?? null);
    const liveGrade = liveCard.grade;
    const fallbackGrade = fallbackCard.grade;
    if (REPORT_CARD_GRADE_RANK[fallbackGrade] >= REPORT_CARD_GRADE_RANK[liveGrade]) {
      excludedCounts["unchanged-or-upgrade"]++;
      continue;
    }

    rows.push({
      assetId,
      ...(supplies.get(assetId) ?? {
        supplyUsd: null, supplyAvailability: "unavailable", supplyUnavailableReason: "missing-supply",
      }),
      liveScore: liveCard.score,
      liveGrade,
      fallbackScore: fallbackCard.score,
      fallbackGrade,
      fallbackTier: admission.tier,
      fallbackEvidenceCeiling: admission.evidenceCeiling,
      fallbackBindingCapKind: fallbackCard.bindingCap?.kind ?? null,
    });
  }

  rows.sort((left, right) => left.supplyUsd === null
    ? right.supplyUsd === null ? left.assetId.localeCompare(right.assetId) : -1
    : right.supplyUsd === null ? 1 : right.supplyUsd - left.supplyUsd || left.assetId.localeCompare(right.assetId));
  return { clockSec: fixedInput.clockSec, rows, assessedCount, excludedCounts };
}

function displayScore(score: number | null): string {
  return score === null ? "NR" : score.toFixed(3).replace(/\.?(0+)$/, "");
}

export function renderLiveWithheldCounterfactualReport(report: LiveWithheldReport): string {
  const { rows } = report;
  const lines = [
    "# Live-withheld counterfactual report",
    "",
    `Capture clock: ${report.clockSec}. Assessed eligible assets: ${report.assessedCount}.`,
    `Excluded findings: ${Object.entries(report.excludedCounts).map(([reason, count]) => `${reason}=${count}`).join(", ")}.`,
    "Assessed counts include unchanged/upgraded outcomes; exclusions are not feed-health evidence.",
    "",
    rows.length === 0
      ? "No assessed eligible strict grade downgrades. Excluded assets are not a healthy-feed claim."
      : "| Asset | Supply (USD) | Live | If producer silent | Fallback tier | Evidence ceiling | Counterfactual binding cap |",
  ];
  if (rows.length > 0) {
    lines.push("|---|---:|---|---|---|---:|---|");
    for (const row of rows) {
      lines.push(
        `| ${row.assetId} | ${row.supplyUsd === null ? `unknown (${row.supplyUnavailableReason})` : Math.round(row.supplyUsd).toLocaleString("en-US")} | ${displayScore(row.liveScore)} / ${row.liveGrade} | ${displayScore(row.fallbackScore)} / ${row.fallbackGrade} | ${row.fallbackTier} | ${row.fallbackEvidenceCeiling ?? "none"} | ${row.fallbackBindingCapKind ?? "none"} |`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const { values } = parseStrictCliArgs(process.argv.slice(2), {
    options: {
      replay: { type: "string" },
      output: { type: "string" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  assertCliUsage(typeof values.replay === "string", "--replay is required");
  const replay = ReplaySchema.parse(JSON.parse(readFileSync(String(values.replay), "utf8")));
  const report = buildLiveWithheldCounterfactualReport(replay);
  const markdown = renderLiveWithheldCounterfactualReport(report);
  if (typeof values.output === "string") {
    writeFileSync(values.output, markdown, "utf8");
  } else {
    process.stdout.write(markdown);
  }
  console.error(`live-withheld-counterfactual: ${report.rows.length} grade drop(s); assessed=${report.assessedCount}; excluded=${JSON.stringify(report.excludedCounts)}`);
}

if (process.argv[1]?.endsWith("check-safety-score-v9-live-withheld.ts")) {
  void runCliEntrypoint(main, { label: "safety-score-v9:live-withheld", usage: USAGE });
}
