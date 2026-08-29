import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import { toErrorMessage } from "@shared/lib/error-utils";
import {
  buildUnknownExposureWarning,
  fetchTextWithRetry,
  freshnessMetadataFromTimestamp,
  requireJsonInput,
  reserveInfoWarning,
  reserveDegradedWarning,
  SOURCE_TIMESTAMP_SPREAD_DEGRADE_SEC,
  slicesFromPercentages,
  summarizeSourceTimestamps,
  type SourceTimestampSummary,
} from "./helpers";
import { extractEscapedJsonValueAfterKey } from "./html";

const SHARE_SCALE = 10n ** 18n;
const PCT_MICRO_SCALE = 100_000_000n;
const PERCENTAGE_TOLERANCE_PCT = 1.5;

interface UsdAiProofOfReservesEntry {
  type?: string;
  name?: string;
  chain?: number;
  share?: string | number;
  amount?: string | number;
}

interface ResolvedReserveBucket {
  name: string;
  risk: ReserveSlice["risk"];
  coinId?: string;
}

type WeightMode = "share" | "amount";
const SHARE_TOTAL_SCALE = 1_000_000_000_000_000_000n;

function quoteUnsafeIntegerWeightFields(raw: string): string {
  return raw.replace(
    /("(?:share|amount)"\s*:\s*)(\d+)(?=\s*[,}])/g,
    (_match, prefix: string, value: string) => `${prefix}"${value}"`,
  );
}

function parseIntegerLike(value: unknown): bigint | null {
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }

  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }

  return null;
}

function ratioToPct(value: bigint, total: bigint): number {
  if (value <= 0n || total <= 0n) {
    return 0;
  }
  return Number((value * PCT_MICRO_SCALE + total / 2n) / total) / 1_000_000;
}

function shareToPct(share: bigint): number {
  return ratioToPct(share, SHARE_SCALE);
}

function hasFullShareCoverage(totalShare: bigint): boolean {
  return totalShare > 0n && Math.abs(shareToPct(totalShare) - 100) <= PERCENTAGE_TOLERANCE_PCT;
}

function createPartialShareCoverageWarning(totalShareDeclared: bigint): LiveReserveWarning {
  return reserveDegradedWarning(
    "usdai-share-coverage-gap",
    `USD.AI share-bearing rows cover only ${shareToPct(totalShareDeclared).toFixed(1)}% of reserves`,
  );
}

function pluralizeEntries(count: number): string {
  return count === 1 ? "entry" : "entries";
}

function pluralizeIgnoredVerb(count: number): string {
  return count === 1 ? "was" : "were";
}

function normalizeBucketKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toUpperCase();
}

function resolveTbillBucket(name: string): ResolvedReserveBucket {
  const normalized = normalizeBucketKey(name);
  switch (normalized) {
    case "PYUSD":
      return { name: "PYUSD (PayPal USD)", risk: "low", coinId: "pyusd-paypal" };
    case "USDC":
      return { name: "USDC", risk: "low", coinId: "usdc-circle" };
    case "USDT":
      return { name: "USDT", risk: "low", coinId: "usdt-tether" };
    case "M":
    case "WM":
    case "M0":
      return { name: "M0 / wM Treasury assets", risk: "low", coinId: "m-m0" };
    default:
      return { name: name.trim(), risk: "low" };
  }
}

// On https://app.usd.ai/reserves, all `timeLastUpdated` entries (73 on a recent
// snapshot) live inside nested `tokens` arrays belonging to the unique
// `dealsDetailsCache` object in the Next.js escaped-JSON payload. Scoping the
// MAX timestamp to that container prevents picking up unrelated timestamps
// that might appear elsewhere (activity feed, news) in future layouts.
const USDAI_PROOF_SCOPE_KEY = '\\"dealsDetailsCache\\":';

function extractUsdAiProofTimestampSummaryFromSlice(proofSlice: string): SourceTimestampSummary | null {
  const rawValues = Array.from(proofSlice.matchAll(/"timeLastUpdated"\s*:\s*"([^"\\]+)"/g))
    .map((match) => match[1]);
  return summarizeSourceTimestamps(rawValues);
}

export function extractUsdAiProofPageTimestampSummary(html: string): SourceTimestampSummary | null {
  let proofSlice: string;
  try {
    proofSlice = extractEscapedJsonValueAfterKey(
      html,
      USDAI_PROOF_SCOPE_KEY,
      "usdai-proof-of-reserves",
    );
  } catch {
    return null;
  }

  return extractUsdAiProofTimestampSummaryFromSlice(proofSlice);
}

export function extractUsdAiProofPageTimestamp(html: string): number | null {
  return extractUsdAiProofPageTimestampSummary(html)?.sourceTimestamp ?? null;
}

export function parseUsdAiProofOfReserves(raw: string): UsdAiProofOfReservesEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(quoteUnsafeIntegerWeightFields(raw)) as unknown;
  } catch (error) {
    throw new Error(
      `usdai-proof-of-reserves payload is malformed: ${toErrorMessage(error)}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error("usdai-proof-of-reserves payload was not an array");
  }

  return parsed as UsdAiProofOfReservesEntry[];
}

export function adaptUsdAiProofOfReserves(
  entries: UsdAiProofOfReservesEntry[],
  sourceTimestamp: number | null = null,
  sourceTimestampSummary: SourceTimestampSummary | null = sourceTimestamp != null
    ? {
        sourceTimestamp,
        latestSourceTimestamp: sourceTimestamp,
        sourceTimestampSpreadSec: 0,
        timestampCount: 1,
      }
    : null,
): AdapterResult {
  const warnings: LiveReserveWarning[] = [];
  const tbillBuckets = new Map<string, { share: bigint; bucket: ResolvedReserveBucket }>();
  const unknownTypes = new Set<string>();
  const chains = new Set<number>();
  const parsedEntries = entries.map((entry) => ({
    type: typeof entry.type === "string" ? entry.type.trim().toUpperCase() : "",
    name: typeof entry.name === "string" ? entry.name.trim() : "",
    chain: typeof entry.chain === "number" && Number.isFinite(entry.chain) ? entry.chain : null,
    share: parseIntegerLike(entry.share),
    amount: parseIntegerLike(entry.amount),
  }));
  const totalShareDeclared = parsedEntries.reduce(
    (acc, entry) => acc + (entry.share && entry.share > 0n ? entry.share : 0n),
    0n,
  );
  const totalAmountDeclared = parsedEntries.reduce(
    (acc, entry) => acc + (entry.amount && entry.amount > 0n ? entry.amount : 0n),
    0n,
  );
  let syntheticUndisclosedShare = 0n;
  const weightMode: WeightMode = (() => {
    if (hasFullShareCoverage(totalShareDeclared)) {
      return "share";
    }

    if (totalAmountDeclared > 0n) {
      if (totalShareDeclared > 0n) {
        warnings.push(createPartialShareCoverageWarning(totalShareDeclared));
      }
      return "amount";
    }

    if (totalShareDeclared > 0n) {
      if (totalShareDeclared < SHARE_TOTAL_SCALE) {
        warnings.push(createPartialShareCoverageWarning(totalShareDeclared));
        syntheticUndisclosedShare = SHARE_TOTAL_SCALE - totalShareDeclared;
        return "share";
      }
      throw new Error(
        `usdai-proof-of-reserves share-bearing rows cover only ${shareToPct(totalShareDeclared).toFixed(1)}% of reserves`,
      );
    }
    throw new Error("usdai-proof-of-reserves payload contained no usable share or amount weights");
  })();
  const ignoredAmountOnlyEntries = weightMode === "share"
    ? parsedEntries.filter((entry) => entry.share == null && entry.amount != null && entry.amount > 0n)
    : [];
  let dealShare = 0n;
  let unknownShare = 0n;
  let totalWeight = 0n;
  let dealCount = 0;

  for (const entry of parsedEntries) {
    const { type, name } = entry;
    const weight = weightMode === "share" ? entry.share : entry.amount;

    if (!type) {
      throw new Error("usdai-proof-of-reserves entry is missing a reserve type");
    }
    if (weight == null) {
      if (weightMode === "share" && entry.amount != null && entry.amount > 0n) {
        continue;
      }
      throw new Error(`usdai-proof-of-reserves entry is missing a valid ${weightMode}: ${name || type}`);
    }
    if (weight === 0n) continue;

    totalWeight += weight;

    if (entry.chain != null) {
      chains.add(entry.chain);
    }

    if (type === "DEAL") {
      dealShare += weight;
      dealCount += 1;
      continue;
    }

    if (type === "TBILL") {
      if (!name) {
        throw new Error("usdai-proof-of-reserves TBILL entry is missing a name");
      }
      const bucket = resolveTbillBucket(name);
      const existing = tbillBuckets.get(bucket.name);
      if (existing) {
        existing.share += weight;
      } else {
        tbillBuckets.set(bucket.name, { share: weight, bucket });
      }
      continue;
    }

    unknownShare += weight;
    unknownTypes.add(type);
  }

  if (ignoredAmountOnlyEntries.length > 0) {
    warnings.push(
      reserveInfoWarning(
        "missing-share-rows-ignored",
        `${ignoredAmountOnlyEntries.length} USD.AI reserve ${pluralizeEntries(ignoredAmountOnlyEntries.length)} `
        + `lacked composition share weights and ${pluralizeIgnoredVerb(ignoredAmountOnlyEntries.length)} ignored while share-bearing rows already covered `
        + `${shareToPct(totalShareDeclared).toFixed(2)}% of reserves`,
      ),
    );
  }

  const weightToPct = (value: bigint) => (
    weightMode === "share"
      ? shareToPct(value)
      : ratioToPct(value, totalAmountDeclared)
  );

  const sliceInputs = Array.from(tbillBuckets.values()).map(({ share, bucket }) => ({
    name: bucket.name,
    pct: weightToPct(share),
    risk: bucket.risk,
    ...(bucket.coinId ? { coinId: bucket.coinId } : {}),
  }));

  if (dealShare > 0n) {
    sliceInputs.push({
      name: "GPU-backed infrastructure loans (NVIDIA hardware)",
      pct: weightToPct(dealShare),
      risk: "high",
    });
  }

  if (syntheticUndisclosedShare > 0n) {
    sliceInputs.push({
      name: "Undisclosed USD.AI reserve buckets",
      pct: weightToPct(syntheticUndisclosedShare),
      risk: "high",
    });
    warnings.push(
      reserveDegradedWarning(
        "usdai-share-coverage-gap",
        `USD.AI payload disclosed only ${shareToPct(totalShareDeclared).toFixed(1)}% of reserves; the remainder is undisclosed`,
      ),
    );
  }

  if (unknownShare > 0n) {
    sliceInputs.push({
      name: "Unmapped USD.AI reserve buckets",
      pct: weightToPct(unknownShare),
      risk: "high",
    });
  }

  if (sliceInputs.length === 0) {
    throw new Error("usdai-proof-of-reserves payload contained no positive-share reserve entries");
  }

  const slices = slicesFromPercentages(sliceInputs, {
    decimals: 1,
    context: "USD.AI proof-of-reserves",
  });

  if (unknownShare > 0n) {
    warnings.push(buildUnknownExposureWarning({
      code: "unknown-reserve-type",
      message: `Unmapped USD.AI reserve types: ${Array.from(unknownTypes).sort().join(", ")}`,
      unknownExposurePct: weightToPct(unknownShare),
    }));
  }
  if (
    sourceTimestampSummary
    && sourceTimestampSummary.sourceTimestampSpreadSec > SOURCE_TIMESTAMP_SPREAD_DEGRADE_SEC
  ) {
    warnings.push(reserveDegradedWarning(
      "source-timestamp-spread",
      `USD.AI proof-row source timestamps span ${sourceTimestampSummary.sourceTimestampSpreadSec} seconds`,
    ));
  }
  const unknownExposureWeight = unknownShare + syntheticUndisclosedShare;

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      apiEntryCount: entries.length,
      liquidBucketCount: tbillBuckets.size,
      dealCount,
      weightingBasis: weightMode,
      ...(weightMode === "share" ? { declaredSharePct: shareToPct(totalShareDeclared) } : {}),
      unknownTypeCount: unknownTypes.size,
      ...(tbillBuckets.size > 0 ? { liquidReserveLabels: Array.from(tbillBuckets.keys()) } : {}),
      ...(chains.size > 0 ? { chains: Array.from(chains).sort((a, b) => a - b) } : {}),
      ...(unknownTypes.size > 0 ? { unknownReserveTypes: Array.from(unknownTypes).sort() } : {}),
      ...(ignoredAmountOnlyEntries.length > 0 ? { ignoredMissingShareEntryCount: ignoredAmountOnlyEntries.length } : {}),
      ...(totalWeight > 0n || syntheticUndisclosedShare > 0n ? { unknownExposurePct: weightToPct(unknownExposureWeight) } : {}),
      ...freshnessMetadataFromTimestamp(
        sourceTimestamp,
        "usdai-proof-of-reserves-api",
        "USD.AI proof-of-reserves API does not expose a trustworthy source timestamp",
      ),
      ...(sourceTimestampSummary != null
        ? {
            oldestSourceTimestamp: sourceTimestampSummary.sourceTimestamp,
            latestSourceTimestamp: sourceTimestampSummary.latestSourceTimestamp,
            sourceTimestampSpreadSec: sourceTimestampSummary.sourceTimestampSpreadSec,
            sourceTimestampCount: sourceTimestampSummary.timestampCount,
          }
        : {}),
    },
  };
}

function extractUsdAiProofPageTimestampFallback(html: string): SourceTimestampSummary | null {
  const rawValues = Array.from(html.matchAll(/\\?"timeLastUpdated\\?"\s*:\s*\\?"([^"\\]+)\\?"/g))
    .map((match) => match[1]);
  return summarizeSourceTimestamps(rawValues);
}

interface UsdAiProofPageTimestampResult {
  timestamp: number | null;
  summary: SourceTimestampSummary | null;
  fallbackWarning?: LiveReserveWarning;
}

async function fetchUsdAiProofPageTimestamp(
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<UsdAiProofPageTimestampResult> {
  const url = config.display?.url;
  if (!url) return { timestamp: null, summary: null };
  let html: string;
  try {
    html = await fetchTextWithRetry(url, signal, 12_000, ctx);
  } catch (error) {
    return {
      timestamp: null,
      summary: null,
      fallbackWarning: reserveInfoWarning(
        "usdai-proof-html-fetch-failed",
        `USD.AI proof-of-reserves page fetch failed (${url}): ${toErrorMessage(error)}`,
      ),
    };
  }
  const scoped = extractUsdAiProofPageTimestampSummary(html);
  if (scoped != null) return { timestamp: scoped.sourceTimestamp, summary: scoped };

  const whole = extractUsdAiProofPageTimestampFallback(html);
  if (whole == null) return { timestamp: null, summary: null };

  return {
    timestamp: whole.sourceTimestamp,
    summary: whole,
    fallbackWarning: reserveInfoWarning(
      "usdai-proof-scope-fallback",
      "USD.AI proof-row scope not found; used whole-page oldest timeLastUpdated as source timestamp",
    ),
  };
}

export async function fetchUsdAiProofOfReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, "usdai-proof-of-reserves");
  const [raw, pageTs] = await Promise.all([
    fetchTextWithRetry(input.url, signal, 12_000, ctx),
    fetchUsdAiProofPageTimestamp(config, signal, ctx),
  ]);
  const result = adaptUsdAiProofOfReserves(
    parseUsdAiProofOfReserves(raw),
    pageTs.timestamp,
    pageTs.summary,
  );
  if (pageTs.fallbackWarning) {
    return {
      ...result,
      warnings: [...(result.warnings ?? []), pageTs.fallbackWarning],
    };
  }
  return result;
}
