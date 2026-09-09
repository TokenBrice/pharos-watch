import type { CompilerProfile } from "./shared";

export const PROFILE: CompilerProfile = {
  product: "USDPT",
  profile: "usdpt-v1",
  officialIndexUrl: "https://www.anchorage.com/platform/usdpt-reserve-attestations-anchorage-digital",
  reportUrl: "https://learn.anchorage.com/07.31.26_USDPT-Stablecoin-Attestation-Report-signed.pdf",
  reportDate: "2026-07-31",
  reportAsOf: "2026-07-31T23:59:59Z",
  reportTimeZone: "Coordinated Universal Time (as printed: July 31, 2026 at 11:59:59 PM UTC)",
  attestor: "Deloitte & Touche LLP",
  engagement: "Independent accountant's examination under AICPA attestation standards (reasonable assurance)",
  conclusion: "unmodified",
  unit: "USD",
  assetRows: [
    {
      code: "cash",
      label: "Cash in FDIC-insured demand deposit accounts at major commercial banks",
      pattern: /^\s*Cash\s+\$([\d,]+(?:\.\d{2})?)\s*$/m,
    },
    {
      code: "money-market-funds",
      label: "Money market funds, at net asset value",
      pattern: /^\s*Money market funds, at net asset value\s+\$([\d,]+(?:\.\d{2})?)\s*$/m,
    },
  ],
  liabilityRows: [
    {
      code: "solana",
      label: "Solana USDPT redeemable tokens outstanding",
      pattern: /^\s*d\.\s+Total USDPT redeemable tokens outstanding\s+([\d,]+(?:\.\d{2})?)\s*$/m,
    },
  ],
  requiredText: [
    { label: "AICPA attestation standards", pattern: /American Institute of Certified Public Accountants \(AICPA\)/ },
    { label: "report date and time", pattern: /July 31, 2026, at 11:59:59 PM Coordinated Universal Time/ },
    { label: "reasonable assurance", pattern: /reasonable assurance/ },
    { label: "favorable opinion", pattern: /In our opinion[\s\S]*?fairly stated, in all material respects/ },
    { label: "report signature date", pattern: /August 28, 2026/ },
    { label: "no nonredeemable tokens", pattern: /There are no temporary or permanent USDPT nonredeemable tokens\./ },
  ],
  rejectedText: [
    { label: "qualified/adverse/disclaimed conclusion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i },
  ],
  reportedTotals: [
    { label: "USDPT reserve assets total", expected: "6935076", pattern: /^\s*Total reserve assets in United States Dollar\s+([\d,]+(?:\.\d{2})?)\s*$/m },
    { label: "USDPT redeemable tokens total", expected: "6823001", pattern: /^\s*Total USDPT redeemable tokens outstanding\s+([\d,]+(?:\.\d{2})?)\s*$/m },
  ],
  reportedAssetTotal: "6935076",
  computedAssetTotal: "6935076",
  reportedLiabilityTotal: "6823001",
};
