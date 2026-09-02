import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { formatCompactUsdWithOptions } from "@shared/lib/format";
import { toErrorMessage } from "@shared/lib/error-utils";
import {
  parseDigestSafetyMapManifest,
  parseDigestSafetyMapUtcDateMs as parseUtcDateMs,
  type DigestSafetyMapManifest as SafetyMapManifest,
  type DigestSafetyMapSummary,
  type DigestSafetyMapTierSummary,
} from "@shared/types/digest-safety-map-contract";
import { throwIfAborted } from "./abort";
import { readResponseTextBoundedWithSignal } from "./response-body";
export type { DigestSafetyMapSummary } from "@shared/types/digest-safety-map-contract";

const MANIFEST_URL = `${SITE_ORIGIN}/safety-scores/map.json`;
const IMAGE_PATH = "/safety-scores/map.png";
const SAFETY_MAP_PHASE_TIMEOUT_MS = 8_000;
const MANIFEST_MAX_BYTES = 16_384;
const UTC_DAY_SEC = 86_400;

/** Maximum whole days a carried-forward map may lag the requested date. */
export const MAX_SAFETY_MAP_CARRY_FORWARD_DAYS = 2;
const MAX_DATA_AGE_SEC = (MAX_SAFETY_MAP_CARRY_FORWARD_DAYS + 1) * 86400;
const MAP_DATE_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

export interface DigestSafetyMapCaptions {
  tweetHook: string;
  telegramAppendixHtml: string;
}

function formatMapDateLabel(date: string): string {
  const parsedMs = parseUtcDateMs(date);
  return parsedMs === null ? date : MAP_DATE_FORMATTER.format(new Date(parsedMs));
}

export type DigestSafetyMapResolution =
  | {
      kind: "available";
      imageUrl: string;
      manifest: SafetyMapManifest;
      freshness: "current" | "carried-forward";
      ageDays: number;
    }
  | { kind: "unavailable"; reason: string };

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
  freshness: "current" | "carried-forward",
  ageDays: number,
): DigestSafetyMapCaptions | null {
  if (!summary || summary.totalMcapUsd <= 0) return null;
  const byTier = new Map(summary.tiers.map((tier) => [tier.tier, tier]));
  const aTier = byTier.get("A");
  const outerTiers = ["C", "D", "F"]
    .map((tier) => byTier.get(tier as DigestSafetyMapTierSummary["tier"]))
    .filter((tier): tier is DigestSafetyMapTierSummary => Boolean(tier));
  if (!aTier || outerTiers.length !== 3) return null;
  const outerCount = outerTiers.reduce((sum, tier) => sum + tier.count, 0);
  const outerMcapUsd = outerTiers.reduce((sum, tier) => sum + tier.mcapUsd, 0);
  const aSharePct = formatSharePct(aTier.mcapUsd, summary.totalMcapUsd);
  const outerSharePct = formatSharePct(outerMcapUsd, summary.totalMcapUsd);
  const mappedSupply = formatUsdCompact(summary.totalMcapUsd);
  // Carried maps name the UTC day they depict so a delayed publication is
  // never presented as today's.
  const mapDateLabel = freshness === "current" ? null : formatMapDateLabel(summary.date);
  const mapReference = mapDateLabel ? `the ${mapDateLabel} map` : "the map";
  const mapHeading = mapDateLabel ? `${mapDateLabel} map` : "Today’s map";
  // `ageDays` is part of the pinned caption interface so callers cannot lose
  // the freshness metadata while composing channel payloads.
  void ageDays;
  return {
    tweetHook: `See ${mapReference}.`,
    telegramAppendixHtml: [
      `<b>${mapHeading}</b>`,
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
  const manifestTimeoutSignal = AbortSignal.timeout(SAFETY_MAP_PHASE_TIMEOUT_MS);
  const manifestSignal = signal
    ? AbortSignal.any([signal, manifestTimeoutSignal])
    : manifestTimeoutSignal;
  try {
    const manifestResponse = await fetch(MANIFEST_URL, {
      headers: { Accept: "application/json" },
      signal: manifestSignal,
    });
    throwIfAborted(signal);
    if (!manifestResponse.ok) {
      await manifestResponse.body?.cancel().catch(() => undefined);
      throwIfAborted(signal);
      return { kind: "unavailable", reason: `manifest-http-${manifestResponse.status}` };
    }
    const raw = await readResponseTextBoundedWithSignal(
      manifestResponse,
      MANIFEST_MAX_BYTES,
      manifestSignal,
    );
    throwIfAborted(signal);
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return { kind: "unavailable", reason: "manifest-invalid-json" };
    }
    const manifest = parseDigestSafetyMapManifest(decoded, "canonical");
    if (!manifest) return { kind: "unavailable", reason: "manifest-invalid" };
    let freshness: "current" | "carried-forward";
    let ageDays: number;
    if (manifest.date === date) {
      freshness = "current";
      ageDays = 0;
    } else {
      const requestedMs = parseUtcDateMs(date);
      const manifestMs = parseUtcDateMs(manifest.date);
      if (requestedMs === null || manifestMs === null) {
        return { kind: "unavailable", reason: "manifest-too-old" };
      }
      const lagSec = (requestedMs - manifestMs) / 1000;
      ageDays = Math.floor(lagSec / UTC_DAY_SEC);
      if (
        !Number.isFinite(lagSec)
        || !Number.isSafeInteger(ageDays)
        || ageDays < 0
        || ageDays > MAX_SAFETY_MAP_CARRY_FORWARD_DAYS
      ) {
        return { kind: "unavailable", reason: "manifest-too-old" };
      }
      freshness = "carried-forward";
    }
    const ageSec = nowSec - manifest.asOfSec;
    if (ageSec < 0 || ageSec >= MAX_DATA_AGE_SEC) {
      return { kind: "unavailable", reason: "manifest-data-stale" };
    }

    const imageUrl = `${SITE_ORIGIN}${IMAGE_PATH}?date=${encodeURIComponent(manifest.date)}`;
    const imageTimeoutSignal = AbortSignal.timeout(SAFETY_MAP_PHASE_TIMEOUT_MS);
    const imageSignal = signal
      ? AbortSignal.any([signal, imageTimeoutSignal])
      : imageTimeoutSignal;
    const imageResponse = await fetch(imageUrl, { method: "HEAD", signal: imageSignal });
    throwIfAborted(signal);
    if (!imageResponse.ok) {
      await imageResponse.body?.cancel().catch(() => undefined);
      throwIfAborted(signal);
      return { kind: "unavailable", reason: `image-http-${imageResponse.status}` };
    }
    const contentType = imageResponse.headers.get("Content-Type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("image/png")) {
      await imageResponse.body?.cancel().catch(() => undefined);
      throwIfAborted(signal);
      return { kind: "unavailable", reason: "image-content-type" };
    }
    await imageResponse.body?.cancel().catch(() => undefined);
    throwIfAborted(signal);
    return { kind: "available", imageUrl, manifest, freshness, ageDays };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { kind: "unavailable", reason: `read-failed:${toErrorMessage(error).slice(0, 80)}` };
  }
}
