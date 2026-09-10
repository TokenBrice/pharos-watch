import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { getIndependentAssuranceManifest, type IndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { fetchIndependentAssuranceReserves, type IndependentAssuranceProfile } from "./independent-assurance";
import type { AdapterContext } from "./types";

// Reviewed 2026-09-09: Gemini's /dollar attestation list loads from the public
// Contentful delivery collection below (space jg6lo9a2ukvr,
// content_type=gusdAttestation, newest first). The May 31, 2026 entry resolves
// to the reviewed May 29, 2026 BPM examination. The delivery token is public
// client-bundle configuration, not a secret; the collection is the official
// machine-readable index.
const GEMINI_ATTESTATION_CONTENT_TYPE = "gusdAttestation";
const GEMINI_REVIEWED_ENTRY_REPORT_DATE = "2026-05-31T05:00:00Z";

interface ContentfulEntry {
  sys?: { contentType?: { sys?: { id?: string } } };
  fields?: { reportDate?: unknown; assetUrl?: { sys?: { id?: string } } };
}

/**
 * Verifies Gemini's Contentful attestation index against the reviewed
 * manifest: every item must be a gusdAttestation with a resolvable PDF asset
 * and a parseable report date, exactly one entry may carry the newest report
 * date, and that entry must be the reviewed entry (pinned date + exact
 * manifest report URL). Any newer entry fails closed.
 */
export function verifyGeminiContentfulIndex(json: string, manifest: IndependentAssuranceManifest): void {
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    throw new Error("gemini-independent-assurance: official index is not valid JSON");
  }
  const root = payload as { items?: unknown; includes?: unknown };
  if (!Array.isArray(root.items) || root.items.length === 0) {
    throw new Error("gemini-independent-assurance: official index has no entries");
  }
  const assets = new Map<string, string>();
  const includes = root.includes as {
    Asset?: Array<{ sys?: { id?: string }; fields?: { file?: { url?: string } } }>;
  } | undefined;
  for (const asset of includes?.Asset ?? []) {
    const id = asset?.sys?.id;
    const url = asset?.fields?.file?.url;
    if (typeof id !== "string" || typeof url !== "string") continue;
    if (url.startsWith("https://")) {
      assets.set(id, url);
    } else if (url.startsWith("//")) {
      assets.set(id, `https:${url}`);
    } else {
      throw new Error("gemini-independent-assurance: official index contains a non-HTTPS asset URL");
    }
  }
  const entries: Array<{ url: string; reportDate: string }> = [];
  for (const item of root.items as unknown[]) {
    const entry = item as ContentfulEntry;
    if (entry?.sys?.contentType?.sys?.id !== GEMINI_ATTESTATION_CONTENT_TYPE) {
      throw new Error("gemini-independent-assurance: official index contains unexpected content types");
    }
    const reportDate = entry?.fields?.reportDate;
    if (typeof reportDate !== "string" || !Number.isFinite(Date.parse(reportDate))) {
      throw new Error("gemini-independent-assurance: official index contains an unparseable report date");
    }
    const assetId = entry?.fields?.assetUrl?.sys?.id;
    const url = typeof assetId === "string" ? assets.get(assetId) : undefined;
    if (!url) {
      throw new Error("gemini-independent-assurance: official index entry has no resolvable PDF asset");
    }
    entries.push({ url, reportDate });
  }
  const newestDate = entries.reduce(
    (max, entry) => (entry.reportDate > max ? entry.reportDate : max),
    entries[0].reportDate,
  );
  const newest = entries.filter((entry) => entry.reportDate === newestDate);
  if (newest.length !== 1) {
    throw new Error("gemini-independent-assurance: ambiguous newest report on official index");
  }
  if (newestDate > GEMINI_REVIEWED_ENTRY_REPORT_DATE) {
    throw new Error("gemini-independent-assurance: newer unreviewed report on official index");
  }
  if (newestDate < GEMINI_REVIEWED_ENTRY_REPORT_DATE) {
    throw new Error("gemini-independent-assurance: reviewed report missing from official index");
  }
  if (newest[0].url !== manifest.reportUrl) {
    throw new Error("gemini-independent-assurance: newest report URL differs from the reviewed manifest");
  }
}

const GEMINI_INDEPENDENT_ASSURANCE_PROFILE: IndependentAssuranceProfile = {
  adapterName: "gemini-independent-assurance",
  product: "GUSD",
  profile: "gusd-v1",
  requiredAssetCodes: ["cash-deposits"],
  classifications: {
    "cash-deposits": {
      name: "USD cash deposits held at U.S. regulated financial institutions (FDIC-insured), net of timing and settlement differences",
      risk: "very-low",
      assetClass: "bank-deposit",
      issuerOrObligor: "State Street and Western Alliance Bank",
      riskFactors: ["counterparty", "custody", "liquidity", "concentration"],
      liquidityHorizon: "immediate",
    },
  },
  isReportCandidate: () => false,
};

export async function fetchGeminiIndependentAssuranceReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
) {
  parseLiveReserveAdapterParams("gemini-independent-assurance", config.params);
  const manifest = getIndependentAssuranceManifest("GUSD");
  const profile: IndependentAssuranceProfile = {
    ...GEMINI_INDEPENDENT_ASSURANCE_PROFILE,
    verifyIndexJson: async (json, reviewed) => verifyGeminiContentfulIndex(json, reviewed),
  };
  return fetchIndependentAssuranceReserves(coin, config, signal, profile, {
    product: "GUSD",
    profile: profile.profile,
    indexHost: new URL(manifest.officialIndexUrl).hostname,
    reportHosts: [new URL(manifest.reportUrl).hostname],
  }, ctx);
}
