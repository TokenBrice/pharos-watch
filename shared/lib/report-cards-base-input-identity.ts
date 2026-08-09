import {
  ReportCardsBaseInputIdentityV1Schema,
  type ReportCardsBaseInputIdentityV1,
} from "../types/report-cards-base-input";
import { sha256Hex } from "./sha256";
import { stableJsonStringifyV1 } from "./stable-json";

export const REPORT_CARDS_BASE_INPUT_GENERATION_ID_PREFIX = "report-cards-input:v1:";
const REPORT_CARDS_BASE_INPUT_UNAVAILABLE_METHODOLOGY = "unavailable";

export interface ReportCardsBaseInputSourceV1 {
  captureKind: "exact-publication-inputs" | "public-reconstruction";
  clockSec: number;
  updatedAt: number;
  activeAssetIds: readonly string[];
  registryFingerprint: string;
  dexGenerationId: string;
  redemptionGenerationId: string;
  dexPayloadFingerprint: string;
  redemptionPayloadFingerprint: string;
  inputMethodologyVersions: {
    safetyScore: string;
    dexLiquidity: readonly string[];
    pegScore: readonly string[];
    redemptionBackstop: readonly string[];
  };
  pegDataById: Readonly<Record<string, unknown>>;
  navPriceById?: Readonly<Record<string, unknown>>;
  activeDepegPeakBpsById: Readonly<Record<string, unknown>>;
  dexLiqMap: Readonly<Record<string, unknown>>;
  redemptionBackstopMap: Readonly<Record<string, unknown>>;
  bluechipMap: Readonly<Record<string, unknown>>;
  resolvedBlacklistStatuses: Readonly<Record<string, unknown>>;
  liveReserveMap: Readonly<Record<string, unknown>>;
  liveReserveProvenanceMap: Readonly<Record<string, unknown>>;
  chainCirculatingById: Readonly<Record<string, unknown>>;
  // Optional because captures predating the aggregate-supply fallback carry no
  // such field. Absent projects as an empty map — the same value the fixed-input
  // schema default supplies — so a pre-field envelope has exactly one identity.
  aggregateCirculatingById?: Readonly<Record<string, unknown>>;
  dexDeploymentSupplyCoverageById: Readonly<Record<string, unknown>>;
  liquidityStale: boolean;
  redemptionStale: boolean;
  inputFreshness: unknown;
}

function domainDigest(domain: string, payload: unknown): string {
  return sha256Hex(stableJsonStringifyV1({ domain, payload }));
}

function producerVersionsOrUnavailable(values: readonly string[]): string[] {
  return values.length > 0 ? [...values] : [REPORT_CARDS_BASE_INPUT_UNAVAILABLE_METHODOLOGY];
}

// Test seam (keep exported): the only path that returns the *projected identity*
// object. `deriveReportCardsBaseInputGenerationId` returns a digest string, so
// the field-separation and permutation-invariance guards have no public route.
export function projectReportCardsBaseInputIdentityV1(
  source: ReportCardsBaseInputSourceV1,
): ReportCardsBaseInputIdentityV1 {
  const scoreBearingFactsSha256 = domainDigest("report-cards.base-input.score-bearing-facts.v1", {
    pegDataById: source.pegDataById,
    navPriceById: source.navPriceById ?? {},
    activeDepegPeakBpsById: source.activeDepegPeakBpsById,
    dexLiqMap: source.dexLiqMap,
    redemptionBackstopMap: source.redemptionBackstopMap,
    bluechipMap: source.bluechipMap,
    resolvedBlacklistStatuses: source.resolvedBlacklistStatuses,
    liveReserveMap: source.liveReserveMap,
    chainCirculatingById: source.chainCirculatingById,
    aggregateCirculatingById: source.aggregateCirculatingById ?? {},
    dexDeploymentSupplyCoverageById: source.dexDeploymentSupplyCoverageById,
  });
  const scoreBearingFreshnessSha256 = domainDigest("report-cards.base-input.score-bearing-freshness.v1", {
    liquidityStale: source.liquidityStale,
    redemptionStale: source.redemptionStale,
    inputFreshness: source.inputFreshness,
    liveReserveProvenanceMap: source.liveReserveProvenanceMap,
  });

  return ReportCardsBaseInputIdentityV1Schema.parse({
    schemaVersion: 1,
    captureKind: source.captureKind,
    publicationClockSec: source.clockSec,
    sourceUpdatedAtSec: source.updatedAt,
    registry: {
      activeAssetIds: [...source.activeAssetIds],
      fingerprintSha256: source.registryFingerprint,
    },
    producers: {
      dex: { generationId: source.dexGenerationId, payloadSha256: source.dexPayloadFingerprint },
      redemption: {
        generationId: source.redemptionGenerationId,
        payloadSha256: source.redemptionPayloadFingerprint,
      },
    },
    producerMethodologyVersions: {
      dexLiquidity: producerVersionsOrUnavailable(source.inputMethodologyVersions.dexLiquidity),
      pegScore: producerVersionsOrUnavailable(source.inputMethodologyVersions.pegScore),
      redemptionBackstop: producerVersionsOrUnavailable(source.inputMethodologyVersions.redemptionBackstop),
    },
    normalizedSnapshotDigests: {
      scoreBearingFactsSha256,
      scoreBearingFreshnessSha256,
    },
  });
}

// Test seam (keep exported): the `unknown`-input schema fence. Its fail-closed
// rejections (publication clock, methodology-version floor) are unreachable
// through `deriveReportCardsBaseInputGenerationId`, which takes a typed source.
export function projectReportCardsBaseInputIdentity(input: unknown): ReportCardsBaseInputIdentityV1 {
  return ReportCardsBaseInputIdentityV1Schema.parse(input);
}

// Test seam (keep exported): pairs with the fence above for the digest-shape
// assertions on rejected input.
export function computeReportCardsBaseInputGenerationId(input: unknown): string {
  const projection = projectReportCardsBaseInputIdentity(input);
  return `${REPORT_CARDS_BASE_INPUT_GENERATION_ID_PREFIX}${sha256Hex(stableJsonStringifyV1(projection))}`;
}

export function deriveReportCardsBaseInputGenerationId(source: ReportCardsBaseInputSourceV1): string {
  return computeReportCardsBaseInputGenerationId(projectReportCardsBaseInputIdentityV1(source));
}
