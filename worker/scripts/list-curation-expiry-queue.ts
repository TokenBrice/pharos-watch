// Lists reserve disclosures that are admitted now but lose admission within the
// lookahead window. The production reserve resolver is rerun at both clocks:
// its current source-strength, 120-day evidence and whole-asset denominator
// rules remain authoritative. Availability labels are not reserve facts.
//
// Usage:
//   npm run safety-score-v9:expiry-queue -- \
//     --replay <replay-v9.json> [--days <lookahead, default 10>] \
//     [--output <markdown path, default stdout>]
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { resolveReviewedReserveRows } from "../src/lib/safety-score-v9/extension";
import {
  assertCliUsage,
  parseCliInteger,
  parseStrictCliArgs,
  runCliEntrypoint,
  writeCliHelpIfRequested,
} from "../../scripts/lib/cli-args.mjs";

const USAGE = `Usage: npm run safety-score-v9:expiry-queue -- --replay <path> [--days <n>] [--output <path>]`;

const ReplaySchema = z
  .object({
    pipeline: z
      .object({
        fixedInput: z
          .object({
            clockSec: z.number().int().positive(),
            liveReserveMap: z.record(z.string(), z.unknown()).default({}),
            liveToFallbackCoins: z.array(z.string()).default([]),
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
                        .object({ circulatingUsd: z.number().finite().nonnegative().nullable().optional() })
                        .loose()
                        .nullable()
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

interface QueueRow {
  assetId: string;
  compositionAsOf: string;
  ageDays: number;
  supplyUsd: number | null;
  supplyAvailability: "known" | "unavailable";
  supplyUnavailableReason: "missing-captured-supply" | null;
  hasCollateralLinks: boolean;
  adapterState: "none" | "silent-this-cycle";
}

export function buildCurationExpiryQueue(
  replay: z.infer<typeof ReplaySchema>,
  lookaheadDays: number,
  metaById: ReadonlyMap<string, (typeof ACTIVE_META_BY_ID) extends ReadonlyMap<string, infer M> ? M : never> = ACTIVE_META_BY_ID,
): QueueRow[] {
  const { fixedInput, evaluatedSet } = replay.pipeline;
  const supplyByAssetId = new Map(
    evaluatedSet.assets.map((asset) => [
      asset.assetId,
      asset.stressState?.exitPortfolio?.circulatingUsd ?? null,
    ]),
  );
  const futureClockSec = fixedInput.clockSec + lookaheadDays * 86_400;
  const rows: QueueRow[] = [];
  for (const [assetId, meta] of metaById) {
    const liveRows = fixedInput.liveReserveMap[assetId];
    if (Array.isArray(liveRows) && liveRows.length > 0) continue;
    const admitAt = (clockSec: number) =>
      resolveReviewedReserveRows({
        meta,
        clockSec,
        liveReserveRows: [],
        liveFallbackAllowed: fixedInput.liveToFallbackCoins.includes(assetId),
      });
    // Currently-inadmissible compositions already surface in the worklist's
    // RESV/DEP streams; this queue is preventive and lists only admitted
    // compositions that stop being admitted within the lookahead.
    if (admitAt(fixedInput.clockSec) === null) continue;
    if (admitAt(futureClockSec) !== null) continue;
    const review = meta.reserveReview;
    const reserves = meta.reserves ?? [];
    if (reserves.length === 0 || review?.compositionAsOf == null) continue;
    const compositionSec = Date.parse(`${review.compositionAsOf}T00:00:00.000Z`) / 1_000;
    if (!Number.isFinite(compositionSec)) continue;
    rows.push({
      assetId,
      compositionAsOf: review.compositionAsOf,
      ageDays: Math.round(((fixedInput.clockSec - compositionSec) / 86_400) * 10) / 10,
      supplyUsd: supplyByAssetId.get(assetId) ?? null,
      supplyAvailability: supplyByAssetId.get(assetId) == null ? "unavailable" : "known",
      supplyUnavailableReason: supplyByAssetId.get(assetId) == null ? "missing-captured-supply" : null,
      hasCollateralLinks: reserves.some(
        (slice) => slice.coinId != null && (slice.depType ?? "collateral") === "collateral",
      ),
      adapterState: meta.liveReservesConfig != null ? "silent-this-cycle" : "none",
    });
  }
  // Unknowns require review, not a fabricated zero/smallest-supply ranking.
  return rows.sort((left, right) => {
    if (left.supplyUsd === null && right.supplyUsd !== null) return -1;
    if (right.supplyUsd === null && left.supplyUsd !== null) return 1;
    return (right.supplyUsd ?? 0) - (left.supplyUsd ?? 0) || left.assetId.localeCompare(right.assetId);
  });
}

export function renderCurationExpiryQueue(rows: readonly QueueRow[], lookaheadDays: number): string {
  const lines = [
    `# Curated reserve pre-expiry queue (lookahead ${lookaheadDays}d)`,
    "",
    `Queue supply: ${rows.filter((row) => row.supplyUsd !== null).length} known, ${rows.filter((row) => row.supplyUsd === null).length} unavailable; known-supply subtotal USD ${rows.reduce((sum, row) => sum + (row.supplyUsd ?? 0), 0).toLocaleString("en-US")} (not a full-cohort total).`,
    "",
    rows.length === 0
      ? "No admitted curated composition expires within the lookahead window."
      : `| Asset | Supply (USD) | Supply availability | compositionAsOf | Age (d) | Dependency links | Adapter |`,
  ];
  if (rows.length > 0) {
    lines.push("|---|---|---|---|---|---|---|");
    for (const row of rows) {
      lines.push(
        `| ${row.assetId} | ${row.supplyUsd === null ? "unavailable" : Math.round(row.supplyUsd).toLocaleString("en-US")} | ${row.supplyUnavailableReason ?? row.supplyAvailability} | ${row.compositionAsOf} | ${row.ageDays} | ${row.hasCollateralLinks ? "yes" : "no"} | ${row.adapterState} |`,
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
      days: { type: "string" },
      output: { type: "string" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  assertCliUsage(typeof values.replay === "string", "--replay is required");
  const lookaheadDays =
    values.days === undefined ? 10 : parseCliInteger(String(values.days), { name: "--days", min: 1 });
  const replay = ReplaySchema.parse(JSON.parse(readFileSync(String(values.replay), "utf8")));
  const rows = buildCurationExpiryQueue(replay, lookaheadDays);
  const markdown = renderCurationExpiryQueue(rows, lookaheadDays);
  if (typeof values.output === "string") {
    writeFileSync(values.output, markdown, "utf8");
  } else {
    process.stdout.write(markdown);
  }
  console.error(`curation-expiry-queue: ${rows.length} admitted composition(s) expiring within ${lookaheadDays}d`);
}

if (process.argv[1]?.endsWith("list-curation-expiry-queue.ts")) {
  void runCliEntrypoint(main, { label: "curation-expiry-queue", usage: USAGE });
}
