import complianceAsset from "@shared/data/stablecoins/coins.compliance.generated.json";
import { getSnapshotSafetyAssessment } from "@/lib/safety-grade-snapshot";
import { GENIUS_REGIME_STATE, isGeniusRegimeEffective } from "@shared/lib/compliance-regime-state";
import { SAFETY_SCORE_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/constants";
import { ACTIVE_STABLECOINS, TRACKED_META_BY_ID, TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";

/** Build-time coverage facts for the /api/ header and the team-plan card; counted, never hardcoded. */
export interface ApiCoverageFacts {
  stablecoins: number;
  deployments: number;
  chains: number;
  complianceDossiers: number;
  methodologyLabel: string;
}

export function getApiCoverageFacts(): ApiCoverageFacts {
  const chains = new Set<string>();
  let deployments = 0;
  for (const coin of TRACKED_STABLECOINS) {
    for (const contract of [...(coin.contracts ?? []), ...(coin.tradedContracts ?? [])]) {
      deployments += 1;
      chains.add(contract.chain);
    }
  }
  return {
    stablecoins: ACTIVE_STABLECOINS.length,
    deployments,
    chains: chains.size,
    complianceDossiers: complianceAsset.length,
    methodologyLabel: SAFETY_SCORE_METHODOLOGY_VERSION_LABEL,
  };
}

/** Sample asset for the integration previews: the same coin the claim list grades. */
const PREVIEW_STABLECOIN_ID = "usdc-circle";

export interface ApiPreviewExamples {
  /** Release date of the grades and dossiers the examples carry. */
  asOfDate: string;
  riskGateResponse: string;
  complianceResponse: string;
  badge: { symbol: string; name: string; grade: string; score: number } | null;
}

type ComplianceRecord = (typeof complianceAsset)[number];

/**
 * Integration-preview examples from release data, so the page never contradicts
 * itself: the Safety grade and score come from the same scores-latest snapshot as
 * the claim list, and the compliance fields from the reviewed dossier. Market
 * fields are labeled illustrative where they render.
 */
export function buildApiPreviewExamples(asOfDate: string): ApiPreviewExamples {
  const meta = TRACKED_META_BY_ID.get(PREVIEW_STABLECOIN_ID);
  const assessment = getSnapshotSafetyAssessment(PREVIEW_STABLECOIN_ID);
  const record = complianceAsset.find((entry: ComplianceRecord) => entry.id === PREVIEW_STABLECOIN_ID);
  const symbol = meta?.symbol ?? "USDC";
  const name = meta?.name ?? "USD Coin";
  const geniusEffective = isGeniusRegimeEffective(GENIUS_REGIME_STATE);
  const mica = record?.mica ?? null;
  const genius = record?.genius ?? null;

  const riskGate = {
    schemaVersion: 1,
    requestedCount: 1,
    resolvedCount: 1,
    unresolved: [],
    assets: {
      [PREVIEW_STABLECOIN_ID]: {
        identity: { id: PREVIEW_STABLECOIN_ID, symbol, name, status: "active", pegCurrency: "USD" },
        safety: assessment
          ? { ratingStatus: "rated", grade: assessment.grade, score: assessment.score, publicationStatus: "current", unavailableReason: null }
          : { ratingStatus: null, grade: null, score: null, publicationStatus: "unavailable", unavailableReason: "safety-score-unavailable" },
        dews: { score: 6, band: "CALM", ageClassification: "fresh", unavailableReason: null },
        peg: { price: 0.9999, priceSource: "consensus", currentDeviationBps: -1, activeDepeg: null, unavailableReason: null },
        ddr: { outlook: null, unavailableReason: "no-ddr-row" },
        liquidity: { liquidityScore: 80, totalTvlUsd: 912000000, poolCount: 260, unavailableReason: null },
        redemption: { score: null, routeFamily: "offchain-issuer", accessModel: "issuer-api", immediateCapacityUsd: null, unavailableReason: null },
        controls: { freezeable: true, liveFreezeTrackerCovered: true },
        compliance: {
          micaStatus: mica?.status ?? null,
          micaTokenType: mica?.tokenType ?? null,
          geniusStatus: genius?.authorizationStatus ?? null,
          geniusRegimeEffective: geniusEffective,
          unavailableReason: mica || genius ? null : "not-reviewed",
        },
      },
    },
    _meta: {
      status: "fresh",
      dependencies: {
        safetyScore: { status: "fresh", ageSeconds: 1480 },
        dews: { status: "fresh", ageSeconds: 610 },
        pegAnalytics: { status: "fresh", ageSeconds: 240 },
        redemptionBackstops: { status: "fresh", ageSeconds: 5200 },
      },
    },
  };

  const compliance = {
    schemaVersion: 1,
    regimes: {
      genius: {
        effectiveDate: GENIUS_REGIME_STATE.effectiveDate,
        rulemakingPhase: GENIUS_REGIME_STATE.rulemakingPhase,
        isEffective: geniusEffective,
      },
    },
    coin: {
      id: PREVIEW_STABLECOIN_ID,
      symbol,
      mica: mica
        ? {
            status: mica.status,
            tokenType: mica.tokenType ?? null,
            authorizationType: mica.authorizationType ?? null,
            competentAuthority: mica.competentAuthority ?? null,
            authorizedEntity: mica.authorizedEntity ?? null,
          }
        : null,
      genius: genius
        ? {
            applicability: genius.applicability,
            authorizationStatus: genius.authorizationStatus,
            issuerPathway: genius.issuerPathway,
            reserveDisclosurePresent: genius.reserveDisclosurePresent ?? null,
            monthlyAttestationPresent: genius.monthlyAttestationPresent ?? null,
            reviewedAt: genius.reviewedAt,
          }
        : null,
    },
  };

  return {
    asOfDate,
    riskGateResponse: JSON.stringify(riskGate, null, 2),
    complianceResponse: JSON.stringify(compliance, null, 2),
    badge: assessment && assessment.score != null ? { symbol, name, grade: assessment.grade, score: assessment.score } : null,
  };
}
