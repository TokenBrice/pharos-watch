import type { CompilerProfile } from "./shared";

export const PROFILE: CompilerProfile = {
  product: "USDPT",
  profile: "usdpt-v1",
  officialIndexUrl: "https://www.anchorage.com/platform/usdpt-reserve-attestations-anchorage-digital",
  reportUrl: "https://learn.anchorage.com/08.31.26_USDPT_Stablecoin_Attestation_Report%20(FINAL)%20signed_9.28.26.pdf",
  reportDate: "2026-08-31",
  reportAsOf: "2026-08-31T23:59:59Z",
  reportTimeZone: "Coordinated Universal Time (as printed: August 31, 2026 at 11:59:59 PM UTC)",
  attestor: "Deloitte & Touche LLP",
  engagement: "Independent accountant's examination under AICPA attestation standards (reasonable assurance)",
  conclusion: "unmodified",
  unit: "USD",
  assetRows: [
    {
      code: "cash",
      label: "Cash in FDIC-insured demand deposit accounts at major commercial banks",
      // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump; bounded digit runs, no nested quantifier ambiguity.
      pattern: /^\s*Cash\s+\$([\d,]+(?:\.\d{2})?)\s*$/m,
    },
    {
      code: "money-market-funds",
      label: "Money market funds, at net asset value",
      // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump; bounded digit runs, no nested quantifier ambiguity.
      pattern: /^\s*Money market funds, at net asset value\s+\$([\d,]+(?:\.\d{2})?)\s*$/m,
    },
  ],
  liabilityRows: [
    {
      code: "solana",
      label: "Solana USDPT redeemable tokens outstanding",
      // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump; bounded digit runs, no nested quantifier ambiguity.
      pattern: /^\s*d\.\s+Total USDPT redeemable tokens outstanding\s+([\d,]+(?:\.\d{2})?)\s*$/m,
    },
  ],
  requiredText: [
    { label: "AICPA attestation standards", pattern: /American Institute of Certified Public Accountants \(AICPA\)/ },
    { label: "report date and time", pattern: /August 31, 2026, at 11:59:59 PM Coordinated Universal Time/ },
    { label: "reasonable assurance", pattern: /reasonable assurance/ },
    { label: "favorable opinion", pattern: /In our opinion[\s\S]*?fairly stated, in all material respects/ },
    { label: "report signature date", pattern: /September 28, 2026/ },
    { label: "no nonredeemable tokens", pattern: /There are no temporary or permanent USDPT nonredeemable tokens\./ },
  ],
  rejectedText: [
    { label: "qualified/adverse/disclaimed conclusion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i },
  ],
  reportedTotals: [
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump; bounded digit runs, no nested quantifier ambiguity.
    { label: "USDPT reserve assets total", expected: "11289740", pattern: /^\s*Total reserve assets in United States Dollar\s+([\d,]+(?:\.\d{2})?)\s*$/m },
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump; bounded digit runs, no nested quantifier ambiguity.
    { label: "USDPT redeemable tokens total", expected: "11179088", pattern: /^\s*Total USDPT redeemable tokens outstanding\s+([\d,]+(?:\.\d{2})?)\s*$/m },
  ],
  reportedAssetTotal: "11289740",
  computedAssetTotal: "11289740",
  reportedLiabilityTotal: "11179088",
};
