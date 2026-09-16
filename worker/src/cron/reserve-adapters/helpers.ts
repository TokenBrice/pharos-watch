import { readHtmlAttribute as readAttribute, stripTags as stripHtmlTags } from "./html";

export interface PdfAnchor {
  href: string;
  text: string;
}

export function collectPdfAnchors(html: string): PdfAnchor[] {
  const candidates: PdfAnchor[] = [];
  const anchorPattern = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  const gatedPattern = /<[^>]+\bdata-gated-url\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    candidates.push({
      href: match[1] ?? match[2] ?? match[3] ?? "",
      text: stripHtmlTags(match[4] ?? ""),
    });
  }
  for (const match of html.matchAll(gatedPattern)) {
    candidates.push({
      href: match[1] ?? match[2] ?? match[3] ?? "",
      text: readAttribute(match[0] ?? "", "data-gated-asset") ?? "",
    });
  }
  return candidates;
}

export {
  isHttpJsonInput,
  isHttpHtmlInput,
  requireHtmlInput,
  requireJsonInput,
  requireJsonInputFromConfig,
  requireOnchainInput,
} from "./input-guards";
export {
  assertFiniteNonNegativeReserveRows,
  buildCoverageShortfallWarnings,
  buildUnknownExposureWarning,
  buildBucketSlices,
  computeUnknownExposurePct,
  decimalFromDigitString,
  decimalNumberFromBigInt,
  decimalStringFromBigInt,
  isReserveRisk,
  normalizeSlices,
  parseBoundedDecimals,
  parsePositiveNumericLike,
  PCT_SUM_ERROR_TOLERANCE,
  slicesFromPercentages,
  slicesFromValues,
  valueUsdFromBigIntPrice,
  sourceKeySlug,
} from "./slice-math";
export {
  parseTimestampLikeToUnixSeconds,
  freshnessMetadataFromTimestamp,
  notApplicableFreshnessMetadata,
  sameRunRenderClockFreshnessMetadata,
  SOURCE_TIMESTAMP_SPREAD_DEGRADE_SEC,
  summarizeSourceTimestamps,
  summarizeSourceTimestampsRequiringCoverage,
  unverifiedFreshnessMetadata,
  verifiedFreshnessMetadata,
} from "./freshness";
export type { SourceTimestampCoverageSummary, SourceTimestampSummary } from "./freshness";
export {
  HTML_ENTITY_MAP,
  decodeHtmlEntities,
  escapeRegExp,
  extractAnchorWindow,
  extractLabeledSpanText,
  extractTagById,
  htmlLayoutChangedError,
  htmlParseError,
  readHtmlAttribute,
  stripTags,
} from "./html";
export {
  ADAPTER_USER_AGENT,
  fetchJsonAdapterInput,
  fetchJsonPostWithRetry,
  fetchJsonWithRetry,
  fetchPrimaryHtmlInput,
  fetchTextWithRetry,
} from "./request";
export { fetchDefiLlamaPrices } from "./defillama";
export {
  fetchErc20Balance,
  fetchErc20TotalSupply,
  fetchOnchainMulticall3,
  fetchOnchainRateBps,
  fetchOnchainRawCall,
  fetchOnchainUint256,
  fetchTronErc20TotalSupply,
  makeOnchainCallers,
  type OnchainCallers,
  type OnchainMulticall3Call,
  type OnchainRawCaller,
  type OnchainRateProbe,
  type OnchainUint256Caller,
} from "./onchain";
export { fetchMovementFungibleAssetSupply, fetchSolanaTokenSupply, probeOnchainTotalSupply, probeTrackedTokenSupply } from "./token-supply";
export { fetchStarknetTotalSupply } from "./starknet";
export { fetchIcrcLedgerTotalSupply } from "./icp";
export {
  aggregateMultichainErc20Supply,
  chainHasRpc,
  isEvmContract,
  isTronContract,
  type MultichainSupplyAggregate,
  type MultichainSupplyContribution,
} from "./multichain-supply";
export {
  parseDigitString,
  parseFiniteNumber,
  requireRecord,
  strictAmountParser,
  sumBackingAssetAmounts,
  type ParseFiniteNumberOptions,
  type StrictAmountEntry,
} from "./strict-amount";
export { readImplementationSlotAddress, requireExpectedAddress } from "./onchain-identity";
export { buildRedemptionSnapshotMetadata, probeOptionalRedemptionRateBps } from "./redemption";
export { getJsonPath } from "./json-path";
export { catchAndWarn, reserveDegradedWarning, reserveFatalWarning, reserveInfoWarning } from "./warnings";
