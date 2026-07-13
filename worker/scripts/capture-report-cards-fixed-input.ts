import { readFileSync, writeFileSync } from "node:fs";
import { ACTIVE_STABLECOINS, ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { resolveBlacklistStatuses } from "@shared/lib/report-cards";
import { BluechipRatingsMapSchema } from "@shared/types/bluechip";
import { DexLiquidityMapSchema, PegSummaryResponseSchema, StablecoinListResponseSchema } from "@shared/types/market";
import { RedemptionBackstopsResponseSchema } from "@shared/types/redemption";
import { ReportCardsResponseSchema } from "@shared/types/report-cards";
import { StablecoinReservesResponseSchema } from "@shared/types/live-reserves";
import { parseStrictCliArgs, runCliEntrypoint, writeCliHelpIfRequested } from "../../scripts/lib/cli-args.mjs";
import {
  createReportCardsFixedInput,
  parseReportCardsFixedInputCacheValue,
  type ReportCardsFixedInput,
} from "../src/lib/report-cards-fixed-input";
import { computeDexDeploymentSupplyCoverage } from "../src/lib/report-cards-snapshot-inputs";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";

const USAGE = `Usage: npx tsx worker/scripts/capture-report-cards-fixed-input.ts [options]

Options:
  --output <path>                 Fixed build-input JSON (required)
  --baseline-output <path>        Concurrent published report-card payload (required)
  --origin <url>                  Site origin (default: https://pharos.watch)
  --captured-at <iso>             Fixed capture timestamp (required)
  --registry-revision <revision>  Git/catalog revision identifier (required)
  --dex-generation-id <id>        DEX producer generation captured by this input (required)
  --exact-cache-export <path>      Export a local db_cache query result instead of reconstructing
  --concurrency <n>               Reserve endpoint concurrency (default: 6)
  -h, --help                      Show this help`;

interface CaptureOptions {
  origin: string;
  capturedAt: string;
  registryRevision: string;
  dexGenerationId: string;
  concurrency: number;
}

async function fetchJson(origin: string, path: string): Promise<unknown> {
  const response = await fetch(`${origin.replace(/\/$/, "")}${path}`, {
    headers: {
      Accept: "application/json",
      Origin: origin,
      Referer: `${origin.replace(/\/$/, "")}/coverage/`,
    },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${body.slice(0, 160)}`);
  return JSON.parse(body) as unknown;
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await mapper(values[index]!);
      }
    }),
  );
  return results;
}

export async function captureReportCardsFixedInput(
  options: CaptureOptions,
): Promise<{ fixedInput: ReportCardsFixedInput; baseline: unknown }> {
  const configuredCoins = ACTIVE_STABLECOINS.filter((coin) => coin.liveReservesConfig != null);
  const [baselineValue, stablecoinValue, pegValue, dexValue, redemptionValue, bluechipValue, reserveRows] =
    await Promise.all([
      fetchJson(options.origin, "/_site-data/report-cards"),
      fetchJson(options.origin, "/_site-data/stablecoins"),
      fetchJson(options.origin, "/_site-data/peg-summary"),
      fetchJson(options.origin, "/_site-data/dex-liquidity"),
      fetchJson(options.origin, "/_site-data/redemption-backstops"),
      fetchJson(options.origin, "/_site-data/bluechip-ratings"),
      mapConcurrent(configuredCoins, options.concurrency, async (coin) => ({
        coin,
        response: StablecoinReservesResponseSchema.parse(
          await fetchJson(options.origin, `/_site-data/stablecoin-reserves/${encodeURIComponent(coin.id)}`),
        ),
      })),
    ]);

  const baseline = ReportCardsResponseSchema.parse(baselineValue);
  const stablecoins = StablecoinListResponseSchema.parse(stablecoinValue);
  const peg = PegSummaryResponseSchema.parse(pegValue);
  const dex = DexLiquidityMapSchema.parse(dexValue);
  const redemption = RedemptionBackstopsResponseSchema.parse(redemptionValue);
  const bluechip = BluechipRatingsMapSchema.parse(
    Object.fromEntries(Object.entries(bluechipValue as Record<string, unknown>).filter(([key]) => key !== "_meta")),
  );
  const liveReserveMap = new Map<string, (typeof reserveRows)[number]["response"]["reserves"]>();
  const liveReserveProvenanceMap = new Map<string, { source: string; fetchedAt: number }>();
  for (const { coin, response } of reserveRows) {
    if (response.mode !== "live" || response.provenance?.scoringEligible !== true || response.liveAt == null) continue;
    liveReserveMap.set(coin.id, response.reserves);
    liveReserveProvenanceMap.set(coin.id, {
      source: coin.liveReservesConfig!.adapter,
      fetchedAt: response.liveAt,
    });
  }

  const blacklistStatuses = resolveBlacklistStatuses(ACTIVE_STABLECOINS, {
    reserveSlicesById: liveReserveMap,
    trackedMetaById: ACTIVE_META_BY_ID,
  });
  const activeDepegPeakBpsById = Object.fromEntries(
    baseline.cards.flatMap((card) =>
      card.rawInputs.activeDepegBps == null ? [] : [[card.id, card.rawInputs.activeDepegBps]],
    ),
  );
  const inputFreshness = baseline.inputFreshness ?? {
    dexLiquidity: { updatedAt: null, ageSeconds: null, stale: true },
    redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
  };
  const dexDeploymentSupplyCoverageById = Object.fromEntries(
    stablecoins.peggedAssets.flatMap((asset) => {
      const dexRow = dex[asset.id];
      if (!dexRow) return [];
      const coverage = computeDexDeploymentSupplyCoverage(
        asset,
        dexRow.deploymentCoverage?.deployments ?? [],
        new Map(Object.entries(dexRow.chainTvl)),
        {
          asOfSec: baseline.updatedAt,
          maxOutcomeAgeSec: CRON_INTERVALS["sync-dex-liquidity"] * 2,
        },
      );
      return coverage ? [[asset.id, coverage] as const] : [];
    }),
  );
  const fixedClockSec = Math.max(
    baseline.updatedAt,
    ...Object.values(inputFreshness).flatMap((entry) =>
      entry.updatedAt != null && entry.ageSeconds != null ? [entry.updatedAt + entry.ageSeconds] : [],
    ),
  );
  const fixedInput = createReportCardsFixedInput({
    captureKind: "public-reconstruction",
    capturedAt: options.capturedAt,
    sourceGeneration: baseline.publication?.generationId ?? `report-cards:${baseline.updatedAt}`,
    dexGenerationId: options.dexGenerationId,
    redemptionGenerationId: `redemption-backstops-${inputFreshness.redemptionBackstops.updatedAt ?? "unavailable"}`,
    registryRevision: options.registryRevision,
    methodologyVersion: baseline.methodology.version,
    clockSec: fixedClockSec,
    updatedAt: baseline.updatedAt,
    liquidityStale: baseline.liquidityStale ?? inputFreshness.dexLiquidity.stale,
    redemptionStale: baseline.redemptionStale ?? inputFreshness.redemptionBackstops.stale,
    inputFreshness,
    pegDataById: Object.fromEntries(peg.coins.map((coin) => [coin.id, coin])),
    activeDepegPeakBpsById,
    dexLiqMap: dex,
    redemptionBackstopMap: redemption.coins,
    bluechipMap: bluechip,
    resolvedBlacklistStatuses: Object.fromEntries(blacklistStatuses),
    liveReserveMap: Object.fromEntries(liveReserveMap),
    liveReserveProvenanceMap: Object.fromEntries(liveReserveProvenanceMap),
    chainCirculatingById: Object.fromEntries(
      stablecoins.peggedAssets.map((asset) => [asset.id, asset.chainCirculating]),
    ),
    dexDeploymentSupplyCoverageById,
    collateralDriftCoins: baseline.collateralDriftCoins ?? [],
    liveToFallbackCoins: baseline.liveToFallbackCoins ?? [],
  });

  return { fixedInput, baseline: baselineValue };
}

async function main(): Promise<void> {
  const { values } = parseStrictCliArgs(process.argv.slice(2), {
    options: {
      output: { type: "string" },
      "baseline-output": { type: "string" },
      origin: { type: "string", default: "https://pharos.watch" },
      "captured-at": { type: "string" },
      "registry-revision": { type: "string" },
      "dex-generation-id": { type: "string" },
      "exact-cache-export": { type: "string" },
      concurrency: { type: "string", default: "6" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  if (typeof values.output !== "string") throw new Error("--output is required");
  if (typeof values["exact-cache-export"] === "string") {
    // Accept either the raw cache envelope or Wrangler D1's JSON query result.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- explicit local operator input path.
    let raw: unknown = JSON.parse(readFileSync(values["exact-cache-export"], "utf8"));
    if (Array.isArray(raw)) raw = raw[0];
    if (raw && typeof raw === "object" && "results" in raw) {
      raw = (raw as { results?: Array<{ value?: unknown }> }).results?.[0]?.value;
    }
    const fixedInput = await parseReportCardsFixedInputCacheValue(raw);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- explicit local operator output path.
    writeFileSync(values.output, `${JSON.stringify(fixedInput, null, 2)}\n`, "utf8");
    return;
  }
  if (typeof values["baseline-output"] !== "string") throw new Error("--baseline-output is required");
  if (typeof values["captured-at"] !== "string" || !Number.isFinite(Date.parse(values["captured-at"]))) {
    throw new Error("--captured-at must be a valid ISO timestamp");
  }
  if (typeof values["registry-revision"] !== "string") throw new Error("--registry-revision is required");
  if (typeof values["dex-generation-id"] !== "string" || !values["dex-generation-id"].trim()) {
    throw new Error("--dex-generation-id is required");
  }
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 12) {
    throw new Error("--concurrency must be an integer from 1 through 12");
  }
  const origin = String(values.origin);
  const { fixedInput, baseline } = await captureReportCardsFixedInput({
    origin,
    capturedAt: values["captured-at"],
    registryRevision: values["registry-revision"],
    dexGenerationId: values["dex-generation-id"],
    concurrency,
  });
  console.warn(
    "[report-cards:capture-fixed-input] Public endpoint fanout is a reconstruction, not exact P0c evidence; use --exact-cache-export for release calibration.",
  );
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- explicit local operator output path.
  writeFileSync(values.output, `${JSON.stringify(fixedInput, null, 2)}\n`, "utf8");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- explicit local operator output path.
  writeFileSync(values["baseline-output"], `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
}

void runCliEntrypoint(main, { label: "report-cards:capture-fixed-input", usage: USAGE });
