export const DIGEST_SAFETY_MAP_TIERS = ["A", "B", "C", "D", "F"] as const;
export type DigestSafetyMapTier = typeof DIGEST_SAFETY_MAP_TIERS[number];
export type DigestSafetyMapProfile = "canonical" | "archive-compatible";

export interface DigestSafetyMapTierSummary {
  tier: DigestSafetyMapTier;
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

export interface DigestSafetyMapManifest {
  date: string;
  asOfSec: number;
  renderedAtSec: number;
  edition: "daily";
  bytes: { png: number };
  mapSummary?: DigestSafetyMapSummary;
}

export interface DigestSafetyMapCapture {
  imageUrl: string;
  freshness: "current" | "carried-forward";
  ageDays: number;
  manifest: DigestSafetyMapManifest & { mapSummary: DigestSafetyMapSummary };
}

export type DigestSafetyMapArchiveTier = Pick<DigestSafetyMapTierSummary, "tier" | "count" | "mcapUsd" | "sharePct">;
export interface DigestSafetyMapArchiveCapture {
  imageUrl: string;
  freshness: "current" | "carried-forward";
  ageDays: number | null;
  manifest: {
    date: string;
    mapSummary: Pick<DigestSafetyMapSummary, "date" | "asOfSec" | "methodologyVersion" | "gradedCount" | "notRatedCount" | "totalMcapUsd"> & {
      tiers: DigestSafetyMapArchiveTier[];
    };
  };
}

export interface DigestSafetyMapContractIssue {
  path: (string | number)[];
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeFinite(value) && Number.isInteger(value);
}

export function parseDigestSafetyMapUtcDateMs(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? parsed.getTime()
    : null;
}

export function isDigestSafetyMapUtcDate(value: unknown): value is string {
  return parseDigestSafetyMapUtcDateMs(value) !== null;
}

export function getDigestSafetyMapSummaryIssues(
  summary: Pick<DigestSafetyMapSummary, "gradedCount" | "totalMcapUsd" | "tiers">,
): DigestSafetyMapContractIssue[] {
  const issues: DigestSafetyMapContractIssue[] = [];
  if (new Set(summary.tiers.map((tier) => tier.tier)).size !== DIGEST_SAFETY_MAP_TIERS.length) {
    issues.push({ path: ["tiers"], message: "Safety Map tiers must be unique and complete" });
  }
  if (summary.tiers.reduce((sum, tier) => sum + tier.count, 0) !== summary.gradedCount) {
    issues.push({ path: ["gradedCount"], message: "Safety Map tier counts must equal gradedCount" });
  }
  const tierMcapUsd = summary.tiers.reduce((sum, tier) => sum + tier.mcapUsd, 0);
  if (Math.abs(tierMcapUsd - summary.totalMcapUsd) > Math.max(0.01, summary.totalMcapUsd * 1e-9)) {
    issues.push({ path: ["totalMcapUsd"], message: "Safety Map tier supply must equal totalMcapUsd" });
  }
  summary.tiers.forEach((tier, index) => {
    const share = summary.totalMcapUsd === 0 ? 0 : (tier.mcapUsd / summary.totalMcapUsd) * 100;
    if (Math.abs(share - tier.sharePct) > 0.11) {
      issues.push({ path: ["tiers", index, "sharePct"], message: "Safety Map tier share must match tier supply" });
    }
  });
  return issues;
}

export function getDigestSafetyMapCaptureIssues(capture: DigestSafetyMapCapture): DigestSafetyMapContractIssue[] {
  const issues: DigestSafetyMapContractIssue[] = [];
  if (capture.manifest.mapSummary.date !== capture.manifest.date) {
    issues.push({ path: ["manifest", "mapSummary", "date"], message: "Safety Map capture dates must match" });
  }
  if (capture.manifest.mapSummary.asOfSec !== capture.manifest.asOfSec) {
    issues.push({ path: ["manifest", "mapSummary", "asOfSec"], message: "Safety Map capture timestamps must match" });
  }
  if (capture.freshness === "current" && capture.ageDays !== 0) {
    issues.push({ path: ["ageDays"], message: "A current Safety Map capture must have ageDays 0" });
  }
  if (capture.freshness === "carried-forward" && capture.ageDays === 0) {
    issues.push({ path: ["ageDays"], message: "A carried-forward Safety Map capture must have positive ageDays" });
  }
  try {
    const imageUrl = new URL(capture.imageUrl);
    if (!imageUrl.pathname.endsWith("/safety-scores/map.png") || imageUrl.searchParams.get("date") !== capture.manifest.date) {
      issues.push({ path: ["imageUrl"], message: "Safety Map image URL must name the manifest date" });
    }
  } catch {
    issues.push({ path: ["imageUrl"], message: "Safety Map image URL must be absolute" });
  }
  return issues;
}

export function parseDigestSafetyMapSummary(value: unknown, profile: "canonical"): DigestSafetyMapSummary | null;
export function parseDigestSafetyMapSummary(value: unknown, profile: "archive-compatible"): DigestSafetyMapArchiveCapture["manifest"]["mapSummary"] | null;
export function parseDigestSafetyMapSummary(value: unknown, profile: DigestSafetyMapProfile) {
  if (!isRecord(value)) return null;
  const { date, asOfSec, methodologyVersion, gradedCount, notRatedCount, totalMcapUsd, tiers: rawTiers } = value;
  const floor = value.floorMcapByTier;
  if (
    !isDigestSafetyMapUtcDate(date)
    || !isNonNegativeInteger(asOfSec)
    || typeof methodologyVersion !== "string" || methodologyVersion.trim().length === 0
    || !isNonNegativeInteger(gradedCount) || !isNonNegativeInteger(notRatedCount)
    || !isNonNegativeFinite(totalMcapUsd) || (profile === "archive-compatible" && totalMcapUsd <= 0)
    || !Array.isArray(rawTiers) || rawTiers.length !== DIGEST_SAFETY_MAP_TIERS.length
    || (profile === "canonical" && (!isRecord(floor) || !isNonNegativeFinite(floor.a) || !isNonNegativeFinite(floor.other)))
  ) return null;

  const seen = new Set<DigestSafetyMapTier>();
  const tiers: Array<DigestSafetyMapTierSummary | DigestSafetyMapArchiveTier> = [];
  for (const rawTier of rawTiers) {
    if (!isRecord(rawTier)) return null;
    const { tier, count, mcapUsd, sharePct } = rawTier;
    if (
      typeof tier !== "string" || !DIGEST_SAFETY_MAP_TIERS.includes(tier as DigestSafetyMapTier)
      || seen.has(tier as DigestSafetyMapTier) || !isNonNegativeInteger(count)
      || !isNonNegativeFinite(mcapUsd) || !isNonNegativeFinite(sharePct) || sharePct > 100
    ) return null;
    seen.add(tier as DigestSafetyMapTier);
    if (profile === "archive-compatible") {
      tiers.push({ tier: tier as DigestSafetyMapTier, count, mcapUsd, sharePct });
      continue;
    }
    if (typeof rawTier.range !== "string" || rawTier.range.trim().length === 0 || !Array.isArray(rawTier.leaders) || rawTier.leaders.length > 3) return null;
    const leaders: DigestSafetyMapTierSummary["leaders"] = [];
    for (const rawLeader of rawTier.leaders) {
      if (!isRecord(rawLeader) || typeof rawLeader.symbol !== "string" || rawLeader.symbol.trim().length === 0
        || !isNonNegativeFinite(rawLeader.score) || rawLeader.score > 100 || !isNonNegativeFinite(rawLeader.mcapUsd)) return null;
      leaders.push({ symbol: rawLeader.symbol, score: rawLeader.score, mcapUsd: rawLeader.mcapUsd });
    }
    tiers.push({ tier: tier as DigestSafetyMapTier, range: rawTier.range, count, mcapUsd, sharePct, leaders });
  }
  const common = { date, asOfSec, methodologyVersion, gradedCount, notRatedCount, totalMcapUsd, tiers };
  if (!DIGEST_SAFETY_MAP_TIERS.every((tier) => seen.has(tier)) || getDigestSafetyMapSummaryIssues(common as DigestSafetyMapSummary).length > 0) return null;
  return profile === "canonical"
    ? {
        date,
        asOfSec,
        methodologyVersion,
        gradedCount,
        notRatedCount,
        totalMcapUsd,
        floorMcapByTier: { a: (floor as { a: number }).a, other: (floor as { other: number }).other },
        tiers,
      }
    : common;
}

export function parseDigestSafetyMapManifest(value: unknown, _profile: "canonical"): DigestSafetyMapManifest | null {
  if (!isRecord(value) || !isDigestSafetyMapUtcDate(value.date) || !Number.isFinite(value.asOfSec)
    || !Number.isFinite(value.renderedAtSec) || value.edition !== "daily" || !isRecord(value.bytes)
    || !Number.isFinite(value.bytes.png) || (value.bytes.png as number) <= 0) return null;
  const manifest: DigestSafetyMapManifest = {
    date: value.date,
    asOfSec: value.asOfSec as number,
    renderedAtSec: value.renderedAtSec as number,
    edition: value.edition,
    bytes: { png: value.bytes.png as number },
  };
  const summary = parseDigestSafetyMapSummary(value.mapSummary, "canonical");
  return summary && summary.date === manifest.date && summary.asOfSec === manifest.asOfSec
    ? { ...manifest, mapSummary: summary }
    : manifest;
}

export function parseDigestSafetyMapCapture(value: unknown, profile: "archive-compatible"): DigestSafetyMapArchiveCapture | null;
export function parseDigestSafetyMapCapture(value: unknown, profile: "canonical"): DigestSafetyMapCapture | null;
export function parseDigestSafetyMapCapture(value: unknown, profile: DigestSafetyMapProfile) {
  if (!isRecord(value) || !isRecord(value.manifest)) return null;
  const { imageUrl, freshness, ageDays, manifest } = value;
  if (typeof imageUrl !== "string" || imageUrl.trim().length === 0 || (freshness !== "current" && freshness !== "carried-forward")
    || !isDigestSafetyMapUtcDate(manifest.date) || (ageDays === undefined ? profile === "canonical" : !isNonNegativeInteger(ageDays))) return null;
  try {
    const url = profile === "canonical" ? new URL(imageUrl) : new URL(imageUrl, "https://pharos.watch");
    if (!url.pathname.endsWith("/safety-scores/map.png") || url.searchParams.get("date") !== manifest.date) return null;
  } catch { return null; }
  if (profile === "archive-compatible") {
    const summary = parseDigestSafetyMapSummary(manifest.mapSummary ?? value.mapSummary ?? value.summary, profile);
    return summary && summary.date === manifest.date
      ? { imageUrl, freshness, ageDays: typeof ageDays === "number" ? ageDays : null, manifest: { date: manifest.date, mapSummary: summary } }
      : null;
  }
  if (!isNonNegativeInteger(manifest.asOfSec) || !isNonNegativeInteger(manifest.renderedAtSec)) return null;
  const parsedManifest = parseDigestSafetyMapManifest(manifest, profile);
  if (!parsedManifest?.mapSummary) return null;
  const capture: DigestSafetyMapCapture = { imageUrl, freshness, ageDays: ageDays as number, manifest: parsedManifest as DigestSafetyMapCapture["manifest"] };
  return getDigestSafetyMapCaptureIssues(capture).length === 0 ? capture : null;
}
