import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { REPORT_CARD_GRADE_RANK } from "@shared/lib/report-card-core";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { V9Grade } from "@shared/types/safety-score-v9";
import { V9AssetEvaluationError } from "@shared/lib/safety-score-v9/evaluate-set";
import { V9GradeSchema } from "@shared/types/safety-score-v9";
import { V9RatingStatusSchema } from "@shared/types/safety-score-v9-causes";
import { V9AccessClaimGraphSchema } from "@shared/types/safety-score-v9-access-lookthrough";
import {
  createSafetyScoreV9LiveWithheldCompilation,
  type SafetyScoreV9FactSetExtensionV2,
  type SafetyScoreV9LiveWithheldCompilation,
} from "../src/lib/safety-score-v9/fact-set";
import {
  buildSafetyScoreV9BaselineExtension,
  buildSafetyScoreV9BaselineExtensionFromNormalizedInput,
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

const USAGE = `Usage: npm run safety-score-v9:live-withheld -- --replay <path> [--output <path>] [--workers 1|2|3]
       npm run safety-score-v9:live-withheld -- --replay <path> --shard <i/n> [--output <shard.json>]
       npm run safety-score-v9:live-withheld -- --merge <shard.json> --merge <shard.json> [--output <path>]`;

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
        extension: z.unknown().optional(),
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
  fallbackBindingCapKind: string | null;
}

export interface LiveWithheldReport {
  status: "complete" | "partial";
  failedAssets: { assetId: string; reasonCode: "counterfactual-evaluation-failed"; errorClass: "V9AssetEvaluationError"; message: string }[];
  clockSec: number;
  rows: LiveWithheldRow[];
  assessedCount: number;
  excludedCounts: Record<"no-live" | "already-fallback" | "baseline-pipeline-gap" | "fallback-pipeline-gap" | "unchanged-or-upgrade", number>;
}

export interface LiveWithheldShardSelection {
  index: number;
  count: number;
}

const ShardResultSchema = z.object({
  shard: z.object({
    index: z.number().int().nonnegative(),
    count: z.number().int().positive(),
    baseInputGenerationId: z.string().min(1),
    activeAssetIds: z.array(z.string().min(1)),
  }),
  report: z.object({
    status: z.enum(["complete", "partial"]),
    failedAssets: z.array(z.object({
      assetId: z.string().min(1),
      reasonCode: z.literal("counterfactual-evaluation-failed"),
      errorClass: z.literal("V9AssetEvaluationError"),
      message: z.string().min(1),
    })),
    clockSec: z.number().int().nonnegative(),
    assessedCount: z.number().int().nonnegative(),
    excludedCounts: z.object({
      "no-live": z.number().int().nonnegative(),
      "already-fallback": z.number().int().nonnegative(),
      "baseline-pipeline-gap": z.number().int().nonnegative(),
      "fallback-pipeline-gap": z.number().int().nonnegative(),
      "unchanged-or-upgrade": z.number().int().nonnegative(),
    }),
    rows: z.array(z.object({
      assetId: z.string().min(1),
      supplyUsd: z.number().finite().nonnegative().nullable(),
      supplyAvailability: z.enum(["observed", "unavailable"]),
      supplyUnavailableReason: z.enum(["null-supply", "missing-supply"]).nullable(),
      liveScore: z.number().finite().nullable(),
      liveGrade: V9GradeSchema,
      fallbackScore: z.number().finite().nullable(),
      fallbackGrade: V9GradeSchema,
      fallbackTier: z.enum(["static", "audited-fallback", "curated-fallback", "none"]),
      fallbackBindingCapKind: z.string().nullable(),
    })),
  }),
});

export type LiveWithheldShardResult = z.infer<typeof ShardResultSchema>;

function compareReportRows(left: LiveWithheldRow, right: LiveWithheldRow): number {
  return left.supplyUsd === null
    ? right.supplyUsd === null ? left.assetId.localeCompare(right.assetId) : -1
    : right.supplyUsd === null ? 1 : right.supplyUsd - left.supplyUsd || left.assetId.localeCompare(right.assetId);
}

/** Admit a complete, non-overlapping set of shards from one frozen replay. */
export function mergeLiveWithheldCounterfactualReports(values: readonly unknown[]): LiveWithheldReport {
  const shards = values.map(value => ShardResultSchema.parse(value));
  const first = shards[0];
  if (first === undefined || shards.length !== first.shard.count) {
    throw new Error("Live-withheld merge requires every shard");
  }
  const indices = new Set<number>();
  const rows = new Set<string>();
  const activeAssetIds = [...first.shard.activeAssetIds].sort();
  const sourceIds = JSON.stringify(activeAssetIds);
  if (new Set(activeAssetIds).size !== activeAssetIds.length) throw new Error("Duplicate replay asset IDs in shard");
  const report: LiveWithheldReport = {
    status: "complete",
    failedAssets: [],
    clockSec: first.report.clockSec,
    rows: [],
    assessedCount: 0,
    excludedCounts: { "no-live": 0, "already-fallback": 0, "baseline-pipeline-gap": 0, "fallback-pipeline-gap": 0, "unchanged-or-upgrade": 0 },
  };
  for (const { shard, report: part } of shards) {
    if (shard.count !== first.shard.count || shard.index >= shard.count || indices.has(shard.index) ||
        shard.baseInputGenerationId !== first.shard.baseInputGenerationId || part.clockSec !== report.clockSec ||
        JSON.stringify([...shard.activeAssetIds].sort()) !== sourceIds) {
      throw new Error("Live-withheld shards overlap or come from different replay inputs");
    }
    indices.add(shard.index);
    const assigned = new Set(activeAssetIds.filter((_, index) => index % shard.count === shard.index));
    if (part.status !== (part.failedAssets.length === 0 ? "complete" : "partial")) {
      throw new Error("Live-withheld shard status does not match its failed assets");
    }
    for (const failure of part.failedAssets) {
      if (!assigned.has(failure.assetId) || rows.has(failure.assetId)) throw new Error(`Unexpected failed shard row ${failure.assetId}`);
      rows.add(failure.assetId);
      report.failedAssets.push(failure);
    }
    for (const row of part.rows) {
      if (!assigned.has(row.assetId) || rows.has(row.assetId)) throw new Error(`Unexpected live-withheld shard row ${row.assetId}`);
      rows.add(row.assetId);
      report.rows.push(row);
    }
    report.assessedCount += part.assessedCount;
    for (const reason of Object.keys(report.excludedCounts) as (keyof LiveWithheldReport["excludedCounts"])[]) {
      report.excludedCounts[reason] += part.excludedCounts[reason];
    }
  }
  report.rows.sort(compareReportRows);
  report.failedAssets.sort((left, right) => left.assetId.localeCompare(right.assetId));
  report.status = report.failedAssets.length === 0 ? "complete" : "partial";
  return report;
}

function cardForAsset(cards: readonly ReplayCard[], assetId: string): ReplayCard {
  const card = cards.find((candidate) => candidate.id === assetId);
  if (!card) throw new Error(`Replay candidate has no card for active asset ${assetId}`);
  return card;
}

function fallbackTier(
  admitted: SafetyScoreV9CandidatePipelineResult["extension"]["assets"][number]["reviewedStaticReserveRows"],
): FallbackTier {
  if (admitted == null) return "none";
  return admitted.provenance === "audited-fallback" ? "audited-fallback" : admitted.provenance === "curated-fallback" ? "curated-fallback" : "static";
}

function withLiveReserveWithheld(
  fixedInputValue: SafetyScoreV9CompilerInput,
  assetId: string,
): SafetyScoreV9CompilerInput {
  const draft = structuredClone(fixedInputValue) as Record<string, unknown> & {
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
  compilation?: SafetyScoreV9LiveWithheldCompilation,
): SafetyScoreV9CandidatePipelineResult {
  const replayExtension = compilation?.extension ?? replay.pipeline.extension;
  let extension: unknown;
  if (replayExtension === undefined) {
    extension = buildSafetyScoreV9BaselineExtension(fixedInput, {
      allowRegistryMismatch: true,
      metaById,
    });
  } else {
    const original = compilation === undefined
      ? structuredClone(replayExtension) as SafetyScoreV9FactSetExtensionV2
      : { ...compilation.extension, assets: [...compilation.extension.assets] };
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
    const rebuildExtension = hasGraphs
      ? buildSafetyScoreV9BaselineExtensionFromNormalizedInput
      : buildSafetyScoreV9BaselineExtension;
    const rebuilt = rebuildExtension(rebuiltFixedInput, {
      allowRegistryMismatch: true,
      metaById,
      ...(hasGraphs ? { assetIds: new Set([assetId]) } : {}),
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
      return {
        ...next,
        accessReview: {
          ...next.accessReview!,
          freeze: { ...next.accessReview!.freeze, claimGraph: admitted },
        },
      };
    });
    extension = original;
  }
  return buildSafetyScoreV9Candidate({
    fixedInput,
    extension,
    publishedAtSec: replay.pipeline.candidate.publishedAtSec,
    ...(compilation === undefined ? {} : { liveWithheldCompilation: { source: compilation, assetId } }),
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
  options: { onProgress?: (message: string) => void; shard?: LiveWithheldShardSelection } = {},
): LiveWithheldReport {
  const replay = ReplaySchema.parse(replayValue);
  const startedAt = performance.now();
  const { fixedInput, candidate } = replay.pipeline;
  const shard = options.shard;
  if (shard !== undefined && (!Number.isInteger(shard.index) || !Number.isInteger(shard.count) ||
      shard.count < 1 || shard.index < 0 || shard.index >= shard.count)) {
    throw new Error("Live-withheld shard must satisfy 0 <= index < count");
  }
  const selected = shard === undefined ? undefined
    : new Set([...fixedInput.activeAssetIds].sort().filter((_, index) => index % shard.count === shard.index));
  const alreadyFallback = new Set(fixedInput.liveToFallbackCoins);
  const supplies = supplyByAssetId(replay);
  const rows: LiveWithheldRow[] = [];
  const failedAssets: LiveWithheldReport["failedAssets"] = [];
  const excludedCounts: LiveWithheldReport["excludedCounts"] = {
    "no-live": 0, "already-fallback": 0, "baseline-pipeline-gap": 0,
    "fallback-pipeline-gap": 0, "unchanged-or-upgrade": 0,
  };
  let assessedCount = 0;
  let normalizedInput: SafetyScoreV9CompilerInput | undefined;
  let compilation: SafetyScoreV9LiveWithheldCompilation | undefined;
  let completedCount = 0;

  for (const assetId of fixedInput.activeAssetIds) {
    if (selected !== undefined && !selected.has(assetId)) continue;
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
    const assetStartedAt = performance.now();
    options.onProgress?.(`live-withheld-counterfactual: start asset=${assetId} completed=${completedCount} elapsedMs=${Math.round(assetStartedAt - startedAt)}`);
    normalizedInput ??= normalizeSafetyScoreV9CompilerInput(fixedInput);
    if (replay.pipeline.extension !== undefined) {
      compilation ??= createSafetyScoreV9LiveWithheldCompilation(normalizedInput, replay.pipeline.extension);
    }
    let counterfactual: SafetyScoreV9CandidatePipelineResult;
    try {
      counterfactual = buildCounterfactualPipeline(
        replay, withLiveReserveWithheld(normalizedInput, assetId), assetId, metaById, compilation,
      );
    } catch (error) {
      if (!(error instanceof V9AssetEvaluationError)) throw error;
      failedAssets.push({
        assetId, reasonCode: "counterfactual-evaluation-failed",
        errorClass: "V9AssetEvaluationError", message: error.message,
      });
      completedCount++;
      options.onProgress?.(`live-withheld-counterfactual: failed asset=${assetId} completed=${completedCount} assetMs=${Math.round(performance.now() - assetStartedAt)} elapsedMs=${Math.round(performance.now() - startedAt)} errorClass=${error.name} message=${error.message}`);
      continue;
    }
    completedCount++;
    options.onProgress?.(`live-withheld-counterfactual: complete asset=${assetId} completed=${completedCount} assetMs=${Math.round(performance.now() - assetStartedAt)} elapsedMs=${Math.round(performance.now() - startedAt)}`);
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
      fallbackTier: admission,
      fallbackBindingCapKind: fallbackCard.bindingCap?.kind ?? null,
    });
  }

  rows.sort(compareReportRows);
  failedAssets.sort((left, right) => left.assetId.localeCompare(right.assetId));
  return { status: failedAssets.length === 0 ? "complete" : "partial", failedAssets,
    clockSec: fixedInput.clockSec, rows, assessedCount, excludedCounts };
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
    ...(report.status === "partial" ? [
      `Report status: **partial**. Failed counterfactuals: ${report.failedAssets.length}. Failed assets are not a healthy-feed claim.`,
      "",
      "| Failed asset | Reason code | Error class | Message |",
      "|---|---|---|---|",
      ...report.failedAssets.map(failure =>
        `| ${failure.assetId} | ${failure.reasonCode} | ${failure.errorClass} | ${failure.message.replaceAll("|", "\\|").replace(/[\r\n]+/g, " ")} |`),
      "",
    ] : []),
    rows.length === 0
      ? "No assessed eligible strict grade downgrades. Excluded assets are not a healthy-feed claim."
      : "| Asset | Supply (USD) | Live | If producer silent | Fallback tier | Counterfactual binding cap |",
  ];
  if (rows.length > 0) {
    lines.push("|---|---:|---|---|---|---|");
    for (const row of rows) {
      lines.push(
        `| ${row.assetId} | ${row.supplyUsd === null ? `unknown (${row.supplyUnavailableReason})` : Math.round(row.supplyUsd).toLocaleString("en-US")} | ${displayScore(row.liveScore)} / ${row.liveGrade} | ${displayScore(row.fallbackScore)} / ${row.fallbackGrade} | ${row.fallbackTier} | ${row.fallbackBindingCapKind ?? "none"} |`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

async function runReportWorkers(replayPath: string, count: number): Promise<LiveWithheldReport> {
  const directory = mkdtempSync(join(tmpdir(), "pharos-live-withheld-"));
  const children = Array.from({ length: count }, (_, index) => {
    const output = join(directory, `shard-${index}.json`);
    const child = spawn(process.execPath, [
      ...process.execArgv, "--max-old-space-size=2048", process.argv[1]!,
      "--replay", replayPath, "--shard", `${index + 1}/${count}`, "--output", output,
    ], { stdio: ["ignore", "inherit", "inherit"] });
    const result = new Promise<LiveWithheldShardResult>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code !== 0) {
          reject(new Error(`Live-withheld shard ${index + 1}/${count} failed: ${signal ?? code}`));
          return;
        }
        try {
          resolve(ShardResultSchema.parse(JSON.parse(readFileSync(output, "utf8"))));
        } catch (error) {
          reject(error);
        }
      });
    });
    return { child, result };
  });
  try {
    return mergeLiveWithheldCounterfactualReports(await Promise.all(children.map(({ result }) => result)));
  } catch (error) {
    for (const { child } of children) child.kill();
    await Promise.allSettled(children.map(({ result }) => result));
    throw error;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const startedAt = performance.now();
  const { values } = parseStrictCliArgs(process.argv.slice(2), {
    options: {
      replay: { type: "string" },
      output: { type: "string" },
      workers: { type: "string" },
      shard: { type: "string" },
      merge: { type: "string", multiple: true },
    },
    conflicts: [["workers", "shard"], ["merge", "replay"], ["merge", "workers"], ["merge", "shard"]],
  });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  assertCliUsage(typeof values.replay === "string" || Array.isArray(values.merge), "--replay or --merge is required");
  const workers = values.workers === undefined ? 1 : Number(values.workers);
  assertCliUsage(workers === 1 || workers === 2 || workers === 3, "--workers must be 1, 2 or 3");
  let report: LiveWithheldReport;
  let shardResult: LiveWithheldShardResult | undefined;
  if (Array.isArray(values.merge)) {
    report = mergeLiveWithheldCounterfactualReports(values.merge.map(path => JSON.parse(readFileSync(String(path), "utf8"))));
  } else if (workers > 1) {
    report = await runReportWorkers(String(values.replay), workers);
  } else {
    const match = typeof values.shard === "string" ? /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(values.shard) : null;
    assertCliUsage(values.shard === undefined || match !== null, "--shard must be i/n (one-based)");
    const shard = match === null ? undefined : { index: Number(match[1]) - 1, count: Number(match[2]) };
    assertCliUsage(shard === undefined || (Number.isSafeInteger(shard.count) && shard.index < shard.count), "--shard must satisfy 1 <= i <= n");
    const replay = ReplaySchema.parse(JSON.parse(readFileSync(String(values.replay), "utf8")));
    report = buildLiveWithheldCounterfactualReport(replay, ACTIVE_META_BY_ID, {
      onProgress: message => console.error(shard === undefined ? message : `shard=${shard.index + 1}/${shard.count} ${message}`),
      ...(shard === undefined ? {} : { shard }),
    });
    if (shard !== undefined) {
      shardResult = { shard: { ...shard, baseInputGenerationId: replay.pipeline.fixedInput.baseInputGenerationId,
        activeAssetIds: [...replay.pipeline.fixedInput.activeAssetIds].sort() }, report };
    }
  }
  const output = shardResult === undefined ? renderLiveWithheldCounterfactualReport(report) : `${JSON.stringify(shardResult)}\n`;
  if (typeof values.output === "string") {
    writeFileSync(values.output, output, "utf8");
  } else {
    process.stdout.write(output);
  }
  console.error(`live-withheld-counterfactual: status=${report.status}; ${report.rows.length} grade drop(s); assessed=${report.assessedCount}; failed=${JSON.stringify(report.failedAssets.map(failure => failure.assetId))}; excluded=${JSON.stringify(report.excludedCounts)}; elapsedMs=${Math.round(performance.now() - startedAt)}; maxRssKiB=${process.resourceUsage().maxRSS}`);
  // A shard's failures are judged only after the complete shard set is merged.
  // Mixed outcomes publish an explicitly partial queue; no successful assessment
  // anywhere in the report is still a failed generator.
  if (shardResult === undefined && report.failedAssets.length > 0 &&
      report.assessedCount === 0 && report.excludedCounts["fallback-pipeline-gap"] === 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("check-safety-score-v9-live-withheld.ts")) {
  void runCliEntrypoint(main, { label: "safety-score-v9:live-withheld", usage: USAGE });
}
