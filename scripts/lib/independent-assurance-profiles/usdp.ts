import type { CompilerProfile } from "./shared";

export const PROFILE: CompilerProfile = {
  product: "USDP",
  profile: "usdp-v1",
  officialIndexUrl: "https://www.paxos.com/usdp-transparency",
  reportUrl: "https://framerusercontent.com/assets/oeOuRskMln0RvSNGMfgLTDIjQys.pdf",
  reportDate: "2026-09-30",
  reportAsOf: "2026-09-30T17:00:00-04:00",
  reportTimeZone: "Eastern Daylight Time (UTC-4)",
  reportIssuedAt: "2026-10-23T23:59:00-04:00",
  attestor: "KPMG LLP",
  engagement: "Independent accountants examination under AICPA attestation standards",
  conclusion: "unmodified",
  unit: "USD",
  // Latest (September 30) column only; earlier September 17 amounts are not additive.
  assetRows: [
    { code: "cash", label: "Cash", pattern: /^\s*Cash\s+\$?[0-9][0-9,]*\s+\$?([0-9][0-9,]*)\s*$/m },
    { code: "reverse-repo", label: "Repurchase agreements, at fair value", pattern: /^\s*Repurchase agreements, at fair value\s+\$?[0-9][0-9,]*\s+\$?([0-9][0-9,]*)\s*$/m },
  ],
  liabilityRows: [
    { code: "ethereum", label: "USDP redeemable ethereum tokens", pattern: /^\s*d\. Total USDP redeemable tokens outstanding\s+[0-9][0-9,]*\s+([0-9][0-9,]*)\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s*$/m },
    { code: "solana", label: "USDP redeemable solana tokens", pattern: /^\s*d\. Total USDP redeemable tokens outstanding\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+([0-9][0-9,]*)\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s*$/m },
  ],
  requiredText: [
    { label: "KPMG LLP", pattern: /KPMG LLP/ },
    { label: "examined instant", pattern: /September 30,\s+2026 at 5:00\s+PM\s+Eastern\s+Time/ },
    { label: "assurance standard", pattern: /attestation standards established by the American Institute/ },
    { label: "unmodified conclusion", pattern: /In our opinion, Management.s Assertion is fairly stated, in all material respects/ },
    { label: "all tokens redeemable", pattern: /All USDP tokens are redeemable\. There are no temporary or permanent USDP nonredeemable tokens/ },
  ],
  rejectedText: [{ label: "qualified/adverse/disclaimed opinion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i }],
  reportedTotals: [
    { label: "Exhibit C redemption assets", expected: "26113649", pattern: /^\s*Redemption assets\s+\$?[0-9][0-9,]*\s+\$?([0-9][0-9,]*)\s*$/m },
    { label: "Exhibit C redeemable tokens", expected: "26084307", pattern: /^\s*Less: Amount of USDP redeemable tokens outstandingi\s+\$?[0-9][0-9,]*\s+\$?([0-9][0-9,]*)\s*$/m },
  ],
  reportedAssetTotal: "26113649",
  computedAssetTotal: "26113649",
  reportedLiabilityTotal: "26084307",
};
