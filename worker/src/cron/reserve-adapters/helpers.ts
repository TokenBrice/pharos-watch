import { htmlParseError, readHtmlAttribute as readAttribute, stripTags as stripHtmlTags } from "./html";

export interface PdfAnchor {
  href: string;
  text: string;
}

/** Candidate bound shared by every adapter that reads an issuer index page.
 *  Reviewed indexes carry 40-61 links; a page past this bound is hostile or
 *  broken and fails closed instead of growing an unbounded candidate array. */
const MAX_PDF_ANCHOR_CANDIDATES = 5_000;
/** An opening tag longer than this cannot be a reviewed report link. Bounding
 *  the slice also keeps a malformed page from materializing a whole document
 *  as one "tag". */
const MAX_HTML_TAG_CHARS = 8 * 1024;
const HREF_ATTRIBUTE = /href/i;
const GATED_URL_ATTRIBUTE = /data-gated-url/i;

function isAsciiWordCode(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

/** `<a\b…>`: the tag name is exactly `a`, so `<abbr>`/`<aside>` do not count. */
function isAnchorOpenTag(tag: string): boolean {
  if (tag[0] !== "<" || (tag[1] !== "a" && tag[1] !== "A")) return false;
  return tag.length > 2 && !isAsciiWordCode(tag.charCodeAt(2));
}

function isAnchorCloseTag(tag: string): boolean {
  return tag.length === 4 && tag[1] === "/" && (tag[2] === "a" || tag[2] === "A") && tag[3] === ">";
}

/**
 * Collect report-link candidates from an issuer index page in one linear pass.
 *
 * The previous global regexes scanned to the end of the document for every
 * `<a` without a closing tag, making a multi-MiB adversarial index quadratic in
 * CPU, and appended every match to an unbounded array. Tags are now bounded by
 * the next `>`, anchor text by the next `</a>`, and a page past the candidate
 * bound fails closed as a normal, recorded adapter error.
 */
export function collectPdfAnchors(html: string): PdfAnchor[] {
  const anchors: PdfAnchor[] = [];
  const gated: PdfAnchor[] = [];
  let openAnchor: { href: string; textStart: number } | null = null;
  let index = 0;
  const failIfExceeded = (): void => {
    if (anchors.length + gated.length > MAX_PDF_ANCHOR_CANDIDATES) {
      throw htmlParseError("pdf-anchor-scan", `index page exceeds ${MAX_PDF_ANCHOR_CANDIDATES} anchor candidates`);
    }
  };
  for (;;) {
    const tagStart = html.indexOf("<", index);
    if (tagStart < 0) break;
    const tagEnd = html.indexOf(">", tagStart + 1);
    // Every later `<` would also be unterminated: no further tag can close.
    if (tagEnd < 0) break;
    index = tagEnd + 1;
    if (tagEnd - tagStart + 1 > MAX_HTML_TAG_CHARS) continue;
    const tag = html.slice(tagStart, tagEnd + 1);
    if (GATED_URL_ATTRIBUTE.test(tag)) {
      const href = readAttribute(tag, "data-gated-url");
      if (href != null) {
        gated.push({ href, text: readAttribute(tag, "data-gated-asset") ?? "" });
        failIfExceeded();
      }
    }
    if (openAnchor) {
      if (isAnchorCloseTag(tag)) {
        anchors.push({ href: openAnchor.href, text: stripHtmlTags(html.slice(openAnchor.textStart, tagStart)) });
        failIfExceeded();
        openAnchor = null;
      }
      continue;
    }
    if (!isAnchorOpenTag(tag) || !HREF_ATTRIBUTE.test(tag)) continue;
    const href = readAttribute(tag, "href");
    if (href != null) openAnchor = { href, textStart: tagEnd + 1 };
  }
  // Anchors keep their historical precedence over data-gated buttons.
  return [...anchors, ...gated];
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
  normalizeSlicesWithDiagnostics,
  calculateRawPercentageSumDeviation,
  parseBoundedDecimals,
  parsePositiveNumericLike,
  PCT_SUM_ERROR_TOLERANCE,
  reconcileRowsWithSourceTotal,
  SOURCE_TOTAL_RECONCILIATION_THRESHOLD_PCT,
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
export type {
  SourceTimestampSummary,
  SourceTimestampZonelessPolicy,
} from "./freshness";
export {
  decodeHtmlEntities,
  escapeRegExp,
  extractAnchorWindow,
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
export { fetchMoveFungibleAssetSupply, fetchSolanaTokenSupply, probeOnchainTotalSupply, probeTrackedTokenSupply } from "./token-supply";
export { fetchStarknetTotalSupply } from "./starknet";
export { fetchIcrcLedgerTotalSupply } from "./icp";
export {
  aggregateMultichainErc20Supply,
  aggregateScopedLiabilitySupply,
  chainHasRpc,
  evaluateLiabilityCoverage,
  isEvmContract,
  isTronContract,
  pinnedEvmTokenReader,
  type MultichainSupplyAggregate,
  type MultichainSupplyContribution,
  type ScopedLiabilitySupply,
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
