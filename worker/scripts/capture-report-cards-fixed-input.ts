import { writeFileSync } from "node:fs";
import { ACTIVE_STABLECOINS, ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { resolveBlacklistStatuses } from "@shared/lib/report-cards";
import { BluechipRatingsMapSchema } from "@shared/types/bluechip";
import { DexLiquidityMapSchema, PegSummaryResponseSchema } from "@shared/types/market";
import { RedemptionBackstopsResponseSchema } from "@shared/types/redemption";
import { ReportCardsResponseSchema } from "@shared/types/report-cards";
import { StablecoinReservesResponseSchema } from "@shared/types/live-reserves";
import { parseStrictCliArgs, runCliEntrypoint, writeCliHelpIfRequested } from "../../scripts/lib/cli-args.mjs";
import { normalizeFixedInput, type ReportCardsFixedInput } from "../src/lib/report-cards-fixed-input";

const USAGE = `Usage: npx tsx worker/scripts/capture-report-cards-fixed-input.ts [options]

Options:
  --output <path>                 Fixed build-input JSON (required)
  --baseline-output <path>        Concurrent published report-card payload (required)
  --origin <url>                  Site origin (default: https://pharos.watch)
  --captured-at <iso>             Fixed capture timestamp (required)
  --registry-revision <revision>  Git/catalog revision identifier (required)
  --concurrency <n>               Reserve endpoint concurrency (default: 6)
  -h, --help                      Show this help`;

interface CaptureOptions {
  origin: string;
  capturedAt: string;
  registryRevision: string;
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
  const [baselineValue, pegValue, dexValue, redemptionValue, bluechipValue, reserveRows] = await Promise.all([
    fetchJson(options.origin, "/_site-data/report-cards"),
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

  const fixedInput = normalizeFixedInput({
    schemaVersion: 1,
    capturedAt: options.capturedAt,
    sourceGeneration: baseline.publication?.generationId ?? `report-cards:${baseline.updatedAt}`,
    registryRevision: options.registryRevision,
    methodologyVersion: baseline.methodology.version,
    clockSec: baseline.updatedAt,
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
      concurrency: { type: "string", default: "6" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  if (typeof values.output !== "string") throw new Error("--output is required");
  if (typeof values["baseline-output"] !== "string") throw new Error("--baseline-output is required");
  if (typeof values["captured-at"] !== "string" || !Number.isFinite(Date.parse(values["captured-at"]))) {
    throw new Error("--captured-at must be a valid ISO timestamp");
  }
  if (typeof values["registry-revision"] !== "string") throw new Error("--registry-revision is required");
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 12) {
    throw new Error("--concurrency must be an integer from 1 through 12");
  }
  const origin = String(values.origin);
  const { fixedInput, baseline } = await captureReportCardsFixedInput({
    origin,
    capturedAt: values["captured-at"],
    registryRevision: values["registry-revision"],
    concurrency,
  });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- explicit local operator output path.
  writeFileSync(values.output, `${JSON.stringify(fixedInput, null, 2)}\n`, "utf8");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- explicit local operator output path.
  writeFileSync(values["baseline-output"], `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
}

void runCliEntrypoint(main, { label: "report-cards:capture-fixed-input", usage: USAGE });
