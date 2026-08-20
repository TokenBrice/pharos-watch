// Lists active assets whose curated reserve composition is expired or expiring
// soon, evaluated with the same admission gates production scoring uses
// (`buildSafetyScoreV9ReviewedStandaloneReserveRows` /
// `buildSafetyScoreV9ReviewedCuratedFallbackReserveRows`), so the queue cannot
// drift from the 31-day window, the zero-known-unknown gate, or the D6
// prudential/audit path. "Expiring" is detected by re-evaluating the same gate
// at `clockSec + lookahead`: composition age is the only time-dependent input.
//
// Usage:
//   npm run safety-score-v9:expiry-queue -- \
//     --capture <normalized-capture.json> [--days <lookahead, default 10>] \
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

const USAGE = `Usage: npm run safety-score-v9:expiry-queue -- --capture <path> [--days <n>] [--output <path>]`;

const CaptureSchema = z
  .object({
    clockSec: z.number().int().positive(),
    liveReserveMap: z.record(z.string(), z.unknown()).default({}),
    liveToFallbackCoins: z.array(z.string()).default([]),
    aggregateCirculatingById: z
      .record(
        z.string(),
        z.object({ circulating: z.object({ peggedUSD: z.number().optional() }).loose() }).loose(),
      )
      .default({}),
  })
  .loose();

interface QueueRow {
  assetId: string;
  compositionAsOf: string;
  ageDays: number;
  status: "inadmissible" | "expiring";
  supplyUsd: number;
  hasCollateralLinks: boolean;
  adapterState: "none" | "silent-this-cycle";
}

export function buildCurationExpiryQueue(
  capture: z.infer<typeof CaptureSchema>,
  lookaheadDays: number,
  metaById: ReadonlyMap<string, (typeof ACTIVE_META_BY_ID) extends ReadonlyMap<string, infer M> ? M : never> = ACTIVE_META_BY_ID,
): QueueRow[] {
  const futureClockSec = capture.clockSec + lookaheadDays * 86_400;
  const rows: QueueRow[] = [];
  for (const [assetId, meta] of metaById) {
    if (capture.liveReserveMap[assetId] != null) continue;
    const registryMeta = meta as never;
    const admit =
      meta.liveReservesConfig != null
        ? buildSafetyScoreV9ReviewedCuratedFallbackReserveRows
        : buildSafetyScoreV9ReviewedStandaloneReserveRows;
    const admittedNow = admit(registryMeta, capture.clockSec);
    const admittedAtLookahead = admit(registryMeta, futureClockSec);
    if (admittedNow !== null && admittedAtLookahead !== null) continue;
    const review = meta.reserveReview;
    const reserves = meta.reserves ?? [];
    // Assets with no curated composition at all have nothing to refresh; their
    // gaps belong to the RESV worklist stream, not the expiry queue.
    if (reserves.length === 0 || review?.compositionAsOf == null) continue;
    const compositionSec = Date.parse(`${review.compositionAsOf}T00:00:00.000Z`) / 1_000;
    if (!Number.isFinite(compositionSec)) continue;
    rows.push({
      assetId,
      compositionAsOf: review.compositionAsOf,
      ageDays: Math.round(((capture.clockSec - compositionSec) / 86_400) * 10) / 10,
      status: admittedNow === null ? "inadmissible" : "expiring",
      supplyUsd: capture.aggregateCirculatingById[assetId]?.circulating.peggedUSD ?? 0,
      hasCollateralLinks: reserves.some(
        (slice) => slice.coinId != null && (slice.depType ?? "collateral") === "collateral",
      ),
      adapterState: meta.liveReservesConfig != null ? "silent-this-cycle" : "none",
    });
  }
  // Inadmissible before expiring; largest supply first within each group, so
  // the drain order matches the worklist generator's supply weighting.
  return rows.sort(
    (left, right) =>
      Number(left.status === "expiring") - Number(right.status === "expiring") ||
      right.supplyUsd - left.supplyUsd ||
      left.assetId.localeCompare(right.assetId),
  );
}

export function renderCurationExpiryQueue(rows: readonly QueueRow[], lookaheadDays: number): string {
  const lines = [
    `# Curated reserve expiry queue (lookahead ${lookaheadDays}d)`,
    "",
    rows.length === 0
      ? "No curated composition is inadmissible or expiring within the lookahead window."
      : `| Asset | Status | Supply (USD) | compositionAsOf | Age (d) | Dependency links | Adapter |`,
  ];
  if (rows.length > 0) {
    lines.push("|---|---|---|---|---|---|---|");
    for (const row of rows) {
      lines.push(
        `| ${row.assetId} | ${row.status} | ${Math.round(row.supplyUsd).toLocaleString("en-US")} | ${row.compositionAsOf} | ${row.ageDays} | ${row.hasCollateralLinks ? "yes" : "no"} | ${row.adapterState} |`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const { values } = parseStrictCliArgs(process.argv.slice(2), {
    options: {
      capture: { type: "string" },
      days: { type: "string" },
      output: { type: "string" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  assertCliUsage(typeof values.capture === "string", "--capture is required");
  const lookaheadDays =
    values.days === undefined ? 10 : parseCliInteger(String(values.days), { name: "--days", min: 1 });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- explicit local operator input path.
  const capture = CaptureSchema.parse(JSON.parse(readFileSync(String(values.capture), "utf8")));
  const rows = buildCurationExpiryQueue(capture, lookaheadDays);
  const markdown = renderCurationExpiryQueue(rows, lookaheadDays);
  if (typeof values.output === "string") {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- explicit local operator output path.
    writeFileSync(values.output, markdown, "utf8");
  } else {
    process.stdout.write(markdown);
  }
  console.error(`curation-expiry-queue: ${rows.length} asset(s) inadmissible or expiring within ${lookaheadDays}d`);
}

if (process.argv[1]?.endsWith("list-curation-expiry-queue.ts")) {
  void runCliEntrypoint(main, { label: "curation-expiry-queue", usage: USAGE });
}
