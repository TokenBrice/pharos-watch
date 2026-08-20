// Lists active assets whose curated reserve composition is still admitted for
// scoring today but crosses an admission gate within the lookahead window —
// the preventive complement to the curation worklist, which already owns every
// currently-inadmissible composition. Admission is evaluated with the same
// gates production scoring uses (`buildSafetyScoreV9ReviewedStandaloneReserveRows`
// / `buildSafetyScoreV9ReviewedCuratedFallbackReserveRows`), re-run at
// `clockSec + lookahead`: composition age is the only time-dependent input, so
// the queue cannot drift from the 31-day window, the zero-known-unknown gate,
// or the D6 prudential/audit path.
//
// Usage:
//   npm run safety-score-v9:expiry-queue -- \
//     --replay <replay-v9.json> [--days <lookahead, default 10>] \
//     [--output <markdown path, default stdout>]
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  buildSafetyScoreV9ReviewedCuratedFallbackReserveRows,
  buildSafetyScoreV9ReviewedStandaloneReserveRows,
} from "../src/lib/safety-score-v9-extension-reserves";
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
                        .object({ circulatingUsd: z.number().optional() })
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

interface QueueRow {
  assetId: string;
  compositionAsOf: string;
  ageDays: number;
  supplyUsd: number;
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
      asset.stressState?.exitPortfolio?.circulatingUsd ?? 0,
    ]),
  );
  const futureClockSec = fixedInput.clockSec + lookaheadDays * 86_400;
  const rows: QueueRow[] = [];
  for (const [assetId, meta] of metaById) {
    if (fixedInput.liveReserveMap[assetId] != null) continue;
    const registryMeta = meta as never;
    const admit =
      meta.liveReservesConfig != null
        ? buildSafetyScoreV9ReviewedCuratedFallbackReserveRows
        : buildSafetyScoreV9ReviewedStandaloneReserveRows;
    // Currently-inadmissible compositions already surface in the worklist's
    // RESV/DEP streams; this queue is preventive and lists only admitted
    // compositions that stop being admitted within the lookahead.
    if (admit(registryMeta, fixedInput.clockSec) === null) continue;
    if (admit(registryMeta, futureClockSec) !== null) continue;
    const review = meta.reserveReview;
    const reserves = meta.reserves ?? [];
    if (reserves.length === 0 || review?.compositionAsOf == null) continue;
    const compositionSec = Date.parse(`${review.compositionAsOf}T00:00:00.000Z`) / 1_000;
    if (!Number.isFinite(compositionSec)) continue;
    rows.push({
      assetId,
      compositionAsOf: review.compositionAsOf,
      ageDays: Math.round(((fixedInput.clockSec - compositionSec) / 86_400) * 10) / 10,
      supplyUsd: supplyByAssetId.get(assetId) ?? 0,
      hasCollateralLinks: reserves.some(
        (slice) => slice.coinId != null && (slice.depType ?? "collateral") === "collateral",
      ),
      adapterState: meta.liveReservesConfig != null ? "silent-this-cycle" : "none",
    });
  }
  // Largest supply first, matching the worklist generator's drain priority.
  return rows.sort(
    (left, right) => right.supplyUsd - left.supplyUsd || left.assetId.localeCompare(right.assetId),
  );
}

export function renderCurationExpiryQueue(rows: readonly QueueRow[], lookaheadDays: number): string {
  const lines = [
    `# Curated reserve pre-expiry queue (lookahead ${lookaheadDays}d)`,
    "",
    rows.length === 0
      ? "No admitted curated composition expires within the lookahead window."
      : `| Asset | Supply (USD) | compositionAsOf | Age (d) | Dependency links | Adapter |`,
  ];
  if (rows.length > 0) {
    lines.push("|---|---|---|---|---|---|");
    for (const row of rows) {
      lines.push(
        `| ${row.assetId} | ${Math.round(row.supplyUsd).toLocaleString("en-US")} | ${row.compositionAsOf} | ${row.ageDays} | ${row.hasCollateralLinks ? "yes" : "no"} | ${row.adapterState} |`,
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
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- explicit local operator input path.
  const replay = ReplaySchema.parse(JSON.parse(readFileSync(String(values.replay), "utf8")));
  const rows = buildCurationExpiryQueue(replay, lookaheadDays);
  const markdown = renderCurationExpiryQueue(rows, lookaheadDays);
  if (typeof values.output === "string") {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- explicit local operator output path.
    writeFileSync(values.output, markdown, "utf8");
  } else {
    process.stdout.write(markdown);
  }
  console.error(`curation-expiry-queue: ${rows.length} admitted composition(s) expiring within ${lookaheadDays}d`);
}

if (process.argv[1]?.endsWith("list-curation-expiry-queue.ts")) {
  void runCliEntrypoint(main, { label: "curation-expiry-queue", usage: USAGE });
}
