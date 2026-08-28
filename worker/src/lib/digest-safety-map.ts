import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { formatCompactUsdWithOptions } from "@shared/lib/format";
import { toErrorMessage } from "./error-utils";
import { readResponseTextBoundedWithSignal } from "./response-body";

const MANIFEST_URL = `${SITE_ORIGIN}/safety-scores/map.json`;
const IMAGE_PATH = "/safety-scores/map.png";
const READ_TIMEOUT_MS = 3_000;
const MANIFEST_MAX_BYTES = 16_384;
const MAX_DATA_AGE_SEC = 24 * 60 * 60;

interface SafetyMapManifest {
  date: string;
  asOfSec: number;
  renderedAtSec: number;
  edition: "daily";
  bytes: { png: number };
  mapSummary?: DigestSafetyMapSummary;
}

const SAFETY_MAP_TIERS = ["A", "B", "C", "D", "F"] as const;
type SafetyMapTier = typeof SAFETY_MAP_TIERS[number];

interface DigestSafetyMapTierSummary {
  tier: SafetyMapTier;
  range: string;
  count: number;
  mcapUsd: number;
  sharePct: number;
  leaders: Array<{ symbol: string; score: number; mcapUsd: number }>;
}

export interface DigestSafetyMapSummary {
  date: string;
  asOfSec: number;
  methodologyVersion: string;
  gradedCount: number;
  notRatedCount: number;
  totalMcapUsd: number;
  floorMcapByTier: { a: number; other: number };
  tiers: DigestSafetyMapTierSummary[];
}

export interface DigestSafetyMapCaptions {
  tweetHook: string;
  telegramAppendixHtml: string;
}

export type DigestSafetyMapResolution =
  | { kind: "available"; imageUrl: string; manifest: SafetyMapManifest }
  | { kind: "unavailable"; reason: string };

function parseManifest(value: unknown): SafetyMapManifest | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<SafetyMapManifest>;
  if (
    typeof candidate.date !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/.test(candidate.date)
    || !Number.isFinite(candidate.asOfSec)
    || !Number.isFinite(candidate.renderedAtSec)
    || candidate.edition !== "daily"
    || !candidate.bytes
    || !Number.isFinite(candidate.bytes.png)
    || candidate.bytes.png <= 0
  ) {
    return null;
  }
  const manifest: SafetyMapManifest = {
    date: candidate.date,
    asOfSec: candidate.asOfSec as number,
    renderedAtSec: candidate.renderedAtSec as number,
    edition: candidate.edition,
    bytes: { png: candidate.bytes.png },
  };
  const mapSummary = parseMapSummary((value as { mapSummary?: unknown }).mapSummary);
  return mapSummary && mapSummary.date === manifest.date && mapSummary.asOfSec === manifest.asOfSec
    ? { ...manifest, mapSummary }
    : manifest;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeFinite(value) && Number.isInteger(value);
}

function parseMapSummary(value: unknown): DigestSafetyMapSummary | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const floorMcapByTier = candidate.floorMcapByTier;
  if (
    typeof candidate.date !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/.test(candidate.date)
    || !isNonNegativeInteger(candidate.asOfSec)
    || typeof candidate.methodologyVersion !== "string"
    || candidate.methodologyVersion.trim().length === 0
    || !isNonNegativeInteger(candidate.gradedCount)
    || !isNonNegativeInteger(candidate.notRatedCount)
    || !isNonNegativeFinite(candidate.totalMcapUsd)
    || !floorMcapByTier
    || typeof floorMcapByTier !== "object"
    || !isNonNegativeFinite((floorMcapByTier as { a?: unknown }).a)
    || !isNonNegativeFinite((floorMcapByTier as { other?: unknown }).other)
    || !Array.isArray(candidate.tiers)
    || candidate.tiers.length !== SAFETY_MAP_TIERS.length
  ) {
    return null;
  }
  const gradedCount = candidate.gradedCount;
  const totalMcapUsd = candidate.totalMcapUsd;

  const seenTiers = new Set<SafetyMapTier>();
  const tiers: DigestSafetyMapTierSummary[] = [];
  for (const rawTier of candidate.tiers) {
    if (!rawTier || typeof rawTier !== "object") return null;
    const tier = rawTier as Record<string, unknown>;
    if (
      typeof tier.tier !== "string"
      || !SAFETY_MAP_TIERS.includes(tier.tier as SafetyMapTier)
      || seenTiers.has(tier.tier as SafetyMapTier)
      || typeof tier.range !== "string"
      || tier.range.trim().length === 0
      || !isNonNegativeInteger(tier.count)
      || !isNonNegativeFinite(tier.mcapUsd)
      || !isNonNegativeFinite(tier.sharePct)
      || tier.sharePct > 100
      || !Array.isArray(tier.leaders)
      || tier.leaders.length > 3
    ) {
      return null;
    }
    const leaders: DigestSafetyMapTierSummary["leaders"] = [];
    for (const rawLeader of tier.leaders) {
      if (!rawLeader || typeof rawLeader !== "object") return null;
      const leader = rawLeader as Record<string, unknown>;
      if (
        typeof leader.symbol !== "string"
        || leader.symbol.trim().length === 0
        || !isNonNegativeFinite(leader.score)
        || leader.score > 100
        || !isNonNegativeFinite(leader.mcapUsd)
      ) {
        return null;
      }
      leaders.push({
        symbol: leader.symbol,
        score: leader.score,
        mcapUsd: leader.mcapUsd,
      });
    }
    const parsedTier = {
      tier: tier.tier as SafetyMapTier,
      range: tier.range,
      count: tier.count,
      mcapUsd: tier.mcapUsd,
      sharePct: tier.sharePct,
      leaders,
    };
    seenTiers.add(parsedTier.tier);
    tiers.push(parsedTier);
  }
  if (!SAFETY_MAP_TIERS.every((tier) => seenTiers.has(tier))) return null;
  const tierCount = tiers.reduce((sum, tier) => sum + tier.count, 0);
  const tierMcapUsd = tiers.reduce((sum, tier) => sum + tier.mcapUsd, 0);
  const mcapTolerance = Math.max(0.01, totalMcapUsd * 1e-9);
  if (tierCount !== gradedCount || Math.abs(tierMcapUsd - totalMcapUsd) > mcapTolerance) {
    return null;
  }
  if (tiers.some((tier) => {
    const computedShare = totalMcapUsd === 0
      ? 0
      : (tier.mcapUsd / totalMcapUsd) * 100;
    return Math.abs(computedShare - tier.sharePct) > 0.11;
  })) {
    return null;
  }

  return {
    date: candidate.date,
    asOfSec: candidate.asOfSec,
    methodologyVersion: candidate.methodologyVersion,
    gradedCount,
    notRatedCount: candidate.notRatedCount,
    totalMcapUsd,
    floorMcapByTier: {
      a: (floorMcapByTier as { a: number }).a,
      other: (floorMcapByTier as { other: number }).other,
    },
    tiers,
  };
}

function formatSharePct(mcapUsd: number, totalMcapUsd: number): string {
  return ((mcapUsd / totalMcapUsd) * 100).toFixed(1);
}

function formatUsdCompact(value: number): string {
  return formatCompactUsdWithOptions(value, {
    decimals: { trillion: 1, billion: 1, million: 1, thousand: 0, unit: 0 },
    compactNegative: false,
    invalidFallback: "N/A",
    minimumTier: "million",
    trimTrailingZeros: true,
    useGrouping: true,
    signPosition: "after-currency",
  });
}

export function buildDigestSafetyMapCaptions(
  summary: DigestSafetyMapSummary | undefined,
): DigestSafetyMapCaptions | null {
  if (!summary || summary.totalMcapUsd <= 0) return null;
  const byTier = new Map(summary.tiers.map((tier) => [tier.tier, tier]));
  const aTier = byTier.get("A");
  const outerTiers = ["C", "D", "F"]
    .map((tier) => byTier.get(tier as SafetyMapTier))
    .filter((tier): tier is DigestSafetyMapTierSummary => Boolean(tier));
  if (!aTier || outerTiers.length !== 3) return null;
  const outerCount = outerTiers.reduce((sum, tier) => sum + tier.count, 0);
  const outerMcapUsd = outerTiers.reduce((sum, tier) => sum + tier.mcapUsd, 0);
  const aSharePct = formatSharePct(aTier.mcapUsd, summary.totalMcapUsd);
  const outerSharePct = formatSharePct(outerMcapUsd, summary.totalMcapUsd);
  const mappedSupply = formatUsdCompact(summary.totalMcapUsd);
  return {
    tweetHook: `Of ${mappedSupply.slice(1)} USD in mapped supply, A tier’s ${aTier.count} coins hold ${aSharePct}%; C/D/F’s ${outerCount} hold ${outerSharePct}%. Find yours on today’s map.`,
    telegramAppendixHtml: [
      "<b>Today’s map</b>",
      `Mapped supply: ${mappedSupply} across ${summary.gradedCount} coins`,
      `A tier: ${aTier.count} coins · ${aSharePct}%`,
      `C/D/F tiers: ${outerCount} coins · ${outerSharePct}%`,
    ].join("\n"),
  };
}

export async function resolveDigestSafetyMap(
  date: string,
  nowSec: number,
  signal?: AbortSignal,
): Promise<DigestSafetyMapResolution> {
  const timeoutSignal = AbortSignal.timeout(READ_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  try {
    const manifestResponse = await fetch(MANIFEST_URL, {
      headers: { Accept: "application/json" },
      signal: requestSignal,
    });
    if (!manifestResponse.ok) {
      await manifestResponse.body?.cancel().catch(() => undefined);
      return { kind: "unavailable", reason: `manifest-http-${manifestResponse.status}` };
    }
    const raw = await readResponseTextBoundedWithSignal(
      manifestResponse,
      MANIFEST_MAX_BYTES,
      requestSignal,
    );
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return { kind: "unavailable", reason: "manifest-invalid-json" };
    }
    const manifest = parseManifest(decoded);
    if (!manifest) return { kind: "unavailable", reason: "manifest-invalid" };
    if (manifest.date !== date) return { kind: "unavailable", reason: "manifest-not-today" };
    const ageSec = nowSec - manifest.asOfSec;
    if (ageSec < 0 || ageSec >= MAX_DATA_AGE_SEC) {
      return { kind: "unavailable", reason: "manifest-data-stale" };
    }

    const imageUrl = `${SITE_ORIGIN}${IMAGE_PATH}?date=${encodeURIComponent(date)}`;
    const imageResponse = await fetch(imageUrl, { method: "HEAD", signal: requestSignal });
    if (!imageResponse.ok) {
      await imageResponse.body?.cancel().catch(() => undefined);
      return { kind: "unavailable", reason: `image-http-${imageResponse.status}` };
    }
    const contentType = imageResponse.headers.get("Content-Type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("image/png")) {
      await imageResponse.body?.cancel().catch(() => undefined);
      return { kind: "unavailable", reason: "image-content-type" };
    }
    await imageResponse.body?.cancel().catch(() => undefined);
    return { kind: "available", imageUrl, manifest };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { kind: "unavailable", reason: `read-failed:${toErrorMessage(error).slice(0, 80)}` };
  }
}
