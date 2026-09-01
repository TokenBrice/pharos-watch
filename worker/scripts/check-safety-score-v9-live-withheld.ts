import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { REPORT_CARD_GRADE_RANK } from "@shared/lib/report-card-core";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { V9Grade } from "@shared/types/safety-score-v9";
import {
  buildSafetyScoreV9BaselineExtension,
  type V9ExtensionRegistryMeta,
} from "../src/lib/safety-score-v9-extension";
import {
  buildSafetyScoreV9Candidate,
  type SafetyScoreV9CandidatePipelineResult,
} from "../src/lib/safety-score-v9-candidate";
import {
  computeNativeDexLiquidityPayloadFingerprint,
  normalizeSafetyScoreV9CompilerInput,
  type SafetyScoreV9CompilerInput,
} from "../src/lib/safety-score-v9-native-input";
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
                  grade: z.string(),
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
  supplyUsd: number;
  liveScore: number | null;
  liveGrade: V9Grade;
  fallbackScore: number | null;
  fallbackGrade: V9Grade;
  fallbackTier: FallbackTier;
  fallbackEvidenceCeiling: number | null;
  fallbackBindingCapKind: string | null;
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

function buildCounterfactualPipeline(
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
    const original = structuredClone(replayExtension) as {
      assets?: Array<{ assetId: string }>;
      [key: string]: unknown;
    };
    if (!Array.isArray(original.assets)) throw new Error("Replay extension has no asset set");
    let rebuiltFixedInput = fixedInput;
    if (fixedInput.captureKind === "native-v9-inputs") {
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
    original.assets = original.assets.map((asset) => (asset.assetId === assetId ? target : asset));
    extension = original;
  }
  return buildSafetyScoreV9Candidate({
    fixedInput,
    extension,
    publishedAtSec: replay.pipeline.candidate.publishedAtSec,
  });
}

function supplyByAssetId(replay: Replay): ReadonlyMap<string, number> {
  return new Map(
    replay.pipeline.evaluatedSet.assets.map((asset) => [
      asset.assetId,
      asset.stressState?.exitPortfolio?.circulatingUsd ?? 0,
    ]),
  );
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
): LiveWithheldRow[] {
  const replay = ReplaySchema.parse(replayValue);
  const { fixedInput, candidate } = replay.pipeline;
  const alreadyFallback = new Set(fixedInput.liveToFallbackCoins);
  const supplies = supplyByAssetId(replay);
  const rows: LiveWithheldRow[] = [];

  for (const assetId of fixedInput.activeAssetIds) {
    const meta = metaById.get(assetId);
    if (!meta) throw new Error(`Replay active asset ${assetId} is missing registry metadata`);
    const liveRows = fixedInput.liveReserveMap[assetId];
    if (meta.liveReservesConfig == null || liveRows === undefined || liveRows.length === 0 || alreadyFallback.has(assetId)) {
      continue;
    }

    const liveCard = cardForAsset(candidate.cards, assetId);
    const counterfactual = buildCounterfactualPipeline(
      replay,
      withLiveReserveWithheld(fixedInput, assetId),
      assetId,
      metaById,
    );
    const fallbackCard = counterfactual.candidate.cards.find((card) => card.id === assetId);
    if (!fallbackCard) throw new Error(`Counterfactual candidate has no card for active asset ${assetId}`);
    const extensionAsset = counterfactual.extension.assets.find((asset) => asset.assetId === assetId);
    const admission = fallbackTier(extensionAsset?.reviewedStaticReserveRows ?? null);
    const liveGrade = liveCard.grade as V9Grade;
    const fallbackGrade = fallbackCard.grade as V9Grade;
    if (REPORT_CARD_GRADE_RANK[fallbackGrade] >= REPORT_CARD_GRADE_RANK[liveGrade]) continue;

    rows.push({
      assetId,
      supplyUsd: supplies.get(assetId) ?? 0,
      liveScore: liveCard.score,
      liveGrade,
      fallbackScore: fallbackCard.score,
      fallbackGrade,
      fallbackTier: admission.tier,
      fallbackEvidenceCeiling: admission.evidenceCeiling,
      fallbackBindingCapKind: fallbackCard.bindingCap?.kind ?? null,
    });
  }

  return rows.sort(
    (left, right) => right.supplyUsd - left.supplyUsd || left.assetId.localeCompare(right.assetId),
  );
}

function displayScore(score: number | null): string {
  return score === null ? "NR" : score.toFixed(3).replace(/\.?(0+)$/, "");
}

export function renderLiveWithheldCounterfactualReport(rows: readonly LiveWithheldRow[]): string {
  const lines = [
    "# Live-withheld counterfactual report",
    "",
    rows.length === 0
      ? "No live-backed asset would change grade if its live reserve producer went silent."
      : "| Asset | Supply (USD) | Live | If producer silent | Fallback tier | Evidence ceiling | Counterfactual binding cap |",
  ];
  if (rows.length > 0) {
    lines.push("|---|---:|---|---|---|---:|---|");
    for (const row of rows) {
      lines.push(
        `| ${row.assetId} | ${Math.round(row.supplyUsd).toLocaleString("en-US")} | ${displayScore(row.liveScore)} / ${row.liveGrade} | ${displayScore(row.fallbackScore)} / ${row.fallbackGrade} | ${row.fallbackTier} | ${row.fallbackEvidenceCeiling ?? "none"} | ${row.fallbackBindingCapKind ?? "none"} |`,
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
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- explicit local operator input path.
  const replay = ReplaySchema.parse(JSON.parse(readFileSync(String(values.replay), "utf8")));
  const rows = buildLiveWithheldCounterfactualReport(replay);
  const markdown = renderLiveWithheldCounterfactualReport(rows);
  if (typeof values.output === "string") {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- explicit local operator output path.
    writeFileSync(values.output, markdown, "utf8");
  } else {
    process.stdout.write(markdown);
  }
  console.error(`live-withheld-counterfactual: ${rows.length} grade drop(s)`);
}

if (process.argv[1]?.endsWith("check-safety-score-v9-live-withheld.ts")) {
  void runCliEntrypoint(main, { label: "safety-score-v9:live-withheld", usage: USAGE });
}
