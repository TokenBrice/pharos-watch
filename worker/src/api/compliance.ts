import { API_CACHE_PROFILES as CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { GENIUS_REGIME_STATE, isGeniusRegimeEffective } from "@shared/lib/compliance-regime-state";
import {
  WORKER_ACTIVE_STABLECOINS,
  WORKER_PRE_LAUNCH_STABLECOINS,
  WORKER_TRACKED_META_BY_ID,
  type WorkerRuntimeStablecoinMeta,
} from "@shared/lib/stablecoins/worker-runtime-registry";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import type {
  ComplianceApiGeniusSchema,
  ComplianceApiMicaSchema,
  ComplianceApiRow,
  ComplianceCoinResponse,
  ComplianceListResponse,
} from "@shared/types/compliance-api";
import {
  GENIUS_AUTHORIZATION_STATUS_VALUES,
  MICA_STATUS_VALUES,
  MICA_TOKEN_TYPE_VALUES,
} from "@shared/types/compliance-vocabulary";
import type { GeniusProfile, MicaProfile } from "@shared/types/stablecoin-meta-compliance-schemas";
import type { z } from "zod";
import { addFreshnessHeaders, buildFreshnessMeta } from "../lib/api-freshness";
import { errorResponse, jsonResponse } from "../lib/api-response";

export interface RawComplianceRecord {
  id: string;
  mica?: MicaProfile;
  genius?: GeniusProfile;
}

export const COMPLIANCE_REVIEW_BUDGET_SEC = 90 * DAY_SECONDS;
const VALID_REGIMES = new Set(["mica", "genius", "all"]);
const VALID_MICA_STATUSES = new Set<string>([...MICA_STATUS_VALUES, "unreviewed"]);
const VALID_GENIUS_STATUSES = new Set<string>([...GENIUS_AUTHORIZATION_STATUS_VALUES, "unreviewed"]);
const VALID_TOKEN_TYPES = new Set<string>(MICA_TOKEN_TYPE_VALUES);

let complianceIndexPromise: Promise<{
  byId: ReadonlyMap<string, RawComplianceRecord>;
  reviewTimestampsSec: readonly number[];
}> | null = null;

function parseIsoDateSec(isoDate: string | undefined): number | null {
  if (!isoDate) return null;
  const parsed = Date.parse(`${isoDate}T00:00:00Z`);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

export async function loadComplianceIndex(): Promise<{
  byId: ReadonlyMap<string, RawComplianceRecord>;
  reviewTimestampsSec: readonly number[];
}> {
  if (!complianceIndexPromise) {
    complianceIndexPromise = import("@shared/data/stablecoins/coins.compliance.generated.json").then((mod) => {
      const records = mod.default as RawComplianceRecord[];
      const byId = new Map<string, RawComplianceRecord>();
      const reviewTimestampsSec: number[] = [];
      const regimeReview = parseIsoDateSec(GENIUS_REGIME_STATE.reviewedAt);
      if (regimeReview != null) reviewTimestampsSec.push(regimeReview);
      for (const record of records) {
        byId.set(record.id, record);
        const reviewedAtSec = parseIsoDateSec(record.genius?.reviewedAt);
        if (reviewedAtSec != null) reviewTimestampsSec.push(reviewedAtSec);
      }
      return { byId, reviewTimestampsSec };
    }).catch((error: unknown) => {
      // A failed import must not pin the rejection for the isolate's lifetime.
      complianceIndexPromise = null;
      throw error;
    });
  }
  return complianceIndexPromise;
}

export function resolveComplianceUpdatedAtSec(reviewTimestampsSec: readonly number[], nowSec: number): number {
  let latest = 0;
  for (const ts of reviewTimestampsSec) {
    if (ts <= nowSec && ts > latest) latest = ts;
  }
  if (latest > 0) return latest;
  return parseIsoDateSec(GENIUS_REGIME_STATE.reviewedAt) ?? nowSec;
}

/** GENIUS effectiveness is the curated release phase (one authority with the compliance page), never wall-clock. */
export function resolveGeniusRegimeEffective(): boolean {
  return isGeniusRegimeEffective(GENIUS_REGIME_STATE);
}

function buildRegimesEnvelope() {
  return {
    genius: {
      publicLawDate: GENIUS_REGIME_STATE.publicLawDate,
      finalRulesIssuedAt: GENIUS_REGIME_STATE.finalRulesIssuedAt ?? null,
      statutoryFallbackEffectiveDate: GENIUS_REGIME_STATE.statutoryFallbackEffectiveDate,
      effectiveDate: GENIUS_REGIME_STATE.effectiveDate,
      rulemakingPhase: GENIUS_REGIME_STATE.rulemakingPhase,
      isEffective: resolveGeniusRegimeEffective(),
      sourceLabel: GENIUS_REGIME_STATE.sourceLabel,
      sourceUrl: GENIUS_REGIME_STATE.sourceUrl,
      reviewedAt: GENIUS_REGIME_STATE.reviewedAt,
    },
  };
}

function normalizeMica(mica: MicaProfile | undefined): z.output<typeof ComplianceApiMicaSchema> | null {
  if (!mica) return null;
  return {
    status: mica.status,
    tokenType: mica.tokenType ?? null,
    authorizationType: mica.authorizationType ?? null,
    competentAuthority: mica.competentAuthority ?? null,
    authorizedEntity: mica.authorizedEntity ?? null,
    significant: typeof mica.significant === "boolean" ? mica.significant : null,
    references: mica.references ?? [],
  };
}

function normalizeGenius(genius: GeniusProfile | undefined): z.output<typeof ComplianceApiGeniusSchema> | null {
  if (!genius) return null;
  return {
    applicability: genius.applicability,
    authorizationStatus: genius.authorizationStatus,
    issuerPathway: genius.issuerPathway,
    issuerEntity: genius.issuerEntity ?? null,
    issuerDomicile: genius.issuerDomicile ?? null,
    licensingRegulator: genius.licensingRegulator ?? null,
    primaryFederalRegulator: genius.primaryFederalRegulator ?? null,
    stateRegulator: genius.stateRegulator ?? null,
    foreignExceptionStatus: genius.foreignExceptionStatus ?? null,
    enforcementStatus: genius.enforcementStatus ?? null,
    daspOfferSaleStatus: genius.daspOfferSaleStatus ?? null,
    reserveDisclosurePresent: typeof genius.reserveDisclosurePresent === "boolean" ? genius.reserveDisclosurePresent : null,
    reserveDisclosureUrl: genius.reserveDisclosureUrl ?? null,
    redemptionPolicyPresent: typeof genius.redemptionPolicyPresent === "boolean" ? genius.redemptionPolicyPresent : null,
    monthlyAttestationPresent: typeof genius.monthlyAttestationPresent === "boolean" ? genius.monthlyAttestationPresent : null,
    notes: genius.notes ?? null,
    references: (genius.references ?? []).map((ref) => ({
      label: ref.label,
      url: ref.url,
      sourceKind: ref.sourceKind,
      ...(ref.sourceDate ? { sourceDate: ref.sourceDate } : {}),
      ...(ref.accessedAt ? { accessedAt: ref.accessedAt } : {}),
    })),
    reviewer: genius.reviewer,
    reviewedAt: genius.reviewedAt,
  };
}

function buildComplianceRow(
  meta: WorkerRuntimeStablecoinMeta,
  record: RawComplianceRecord | undefined,
): ComplianceApiRow {
  const mica = normalizeMica(record?.mica);
  const genius = normalizeGenius(record?.genius);
  return {
    id: meta.id,
    symbol: meta.symbol,
    name: meta.name,
    status: meta.status ?? "active",
    pegCurrency: meta.pegCurrency,
    governance: meta.governance,
    backing: meta.flags.backing ?? null,
    navToken: meta.flags.navToken === true,
    yieldBearing: meta.flags.yieldBearing === true,
    mica,
    micaUnavailableReason: mica ? null : "not-reviewed",
    genius,
    geniusUnavailableReason: genius ? null : "not-reviewed",
  };
}

function buildComplianceFreshness(reviewTimestampsSec: readonly number[], nowSec: number) {
  const updatedAt = resolveComplianceUpdatedAtSec(reviewTimestampsSec, nowSec);
  const meta = buildFreshnessMeta(updatedAt, COMPLIANCE_REVIEW_BUDGET_SEC, "compliance", {
    assessedAt: nowSec,
    freshBudgetSec: COMPLIANCE_REVIEW_BUDGET_SEC,
    degradedBudgetSec: COMPLIANCE_REVIEW_BUDGET_SEC * 2,
  });
  const headers = addFreshnessHeaders(
    { "Cache-Control": CACHE_PROFILES.slow },
    updatedAt,
    COMPLIANCE_REVIEW_BUDGET_SEC,
    { assessedAt: nowSec, freshBudgetSec: COMPLIANCE_REVIEW_BUDGET_SEC },
  );
  return { meta, headers };
}

export async function handleCompliance(url: URL): Promise<Response> {
  const regime = url.searchParams.get("regime")?.trim().toLowerCase() || null;
  if (regime && !VALID_REGIMES.has(regime)) {
    return errorResponse(400, "Invalid regime filter; expected mica, genius, or all");
  }

  const micaStatus = url.searchParams.get("micaStatus")?.trim().toLowerCase() || null;
  if (micaStatus && !VALID_MICA_STATUSES.has(micaStatus)) {
    return errorResponse(400, `Invalid micaStatus filter: ${micaStatus}`);
  }

  const geniusStatus = url.searchParams.get("geniusStatus")?.trim().toLowerCase() || null;
  if (geniusStatus && !VALID_GENIUS_STATUSES.has(geniusStatus)) {
    return errorResponse(400, `Invalid geniusStatus filter: ${geniusStatus}`);
  }

  const rawTokenType = url.searchParams.get("tokenType")?.trim().toUpperCase() || null;
  if (rawTokenType && !VALID_TOKEN_TYPES.has(rawTokenType)) {
    return errorResponse(400, "Invalid tokenType filter; expected EMT or ART");
  }

  const peg = url.searchParams.get("peg")?.trim().toUpperCase() || null;

  const rawIncludePreLaunch = url.searchParams.get("includePreLaunch")?.trim().toLowerCase() || null;
  if (rawIncludePreLaunch && rawIncludePreLaunch !== "true" && rawIncludePreLaunch !== "false") {
    return errorResponse(400, "Invalid includePreLaunch parameter; expected true or false");
  }
  const includePreLaunch = rawIncludePreLaunch === "true";

  const { byId, reviewTimestampsSec } = await loadComplianceIndex();
  const nowSec = Math.floor(Date.now() / 1000);
  const { meta, headers } = buildComplianceFreshness(reviewTimestampsSec, nowSec);

  const universe: readonly WorkerRuntimeStablecoinMeta[] = includePreLaunch
    ? [...WORKER_ACTIVE_STABLECOINS, ...WORKER_PRE_LAUNCH_STABLECOINS]
    : WORKER_ACTIVE_STABLECOINS;

  const coins: ComplianceApiRow[] = [];
  let assessedCoins = 0;
  let micaAssessed = 0;
  let geniusAssessed = 0;

  for (const coinMeta of universe) {
    if (peg && coinMeta.pegCurrency.toUpperCase() !== peg) continue;
    const row = buildComplianceRow(coinMeta, byId.get(coinMeta.id));
    if (regime === "mica" && row.mica == null) continue;
    if (regime === "genius" && row.genius == null) continue;
    if (micaStatus === "unreviewed" && row.mica != null) continue;
    if (micaStatus && micaStatus !== "unreviewed" && row.mica?.status !== micaStatus) continue;
    if (geniusStatus === "unreviewed" && row.genius != null) continue;
    if (geniusStatus && geniusStatus !== "unreviewed" && row.genius?.authorizationStatus !== geniusStatus) continue;
    if (rawTokenType && row.mica?.tokenType !== rawTokenType) continue;

    if (row.mica != null) micaAssessed += 1;
    if (row.genius != null) geniusAssessed += 1;
    if (row.mica != null || row.genius != null) assessedCoins += 1;
    coins.push(row);
  }

  const body: ComplianceListResponse = {
    schemaVersion: 1,
    regimes: buildRegimesEnvelope(),
    summary: {
      totalCoins: coins.length,
      assessedCoins,
      unassessedCoins: coins.length - assessedCoins,
      micaAssessed,
      geniusAssessed,
    },
    coins,
    _meta: meta,
  };
  return jsonResponse(body, { headers });
}

export async function handleComplianceCoin(canonicalId: string): Promise<Response> {
  const coinMeta = WORKER_TRACKED_META_BY_ID.get(canonicalId);
  if (!coinMeta) {
    return errorResponse(404, `Unknown stablecoin: ${canonicalId}`);
  }
  const { byId, reviewTimestampsSec } = await loadComplianceIndex();
  const nowSec = Math.floor(Date.now() / 1000);
  const { meta, headers } = buildComplianceFreshness(reviewTimestampsSec, nowSec);

  const body: ComplianceCoinResponse = {
    schemaVersion: 1,
    regimes: buildRegimesEnvelope(),
    coin: buildComplianceRow(coinMeta, byId.get(canonicalId)),
    _meta: meta,
  };
  return jsonResponse(body, { headers });
}
