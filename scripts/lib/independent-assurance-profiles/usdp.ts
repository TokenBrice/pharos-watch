import type { CompilerProfile } from "./shared";

export const PROFILE: CompilerProfile = {
  product: "USDP",
  profile: "usdp-v1",
  officialIndexUrl: "https://www.paxos.com/usdp-transparency",
  reportUrl: "https://framerusercontent.com/assets/Kk04pJ7gWRmVlVJvl5rmYWj25M.pdf",
  reportDate: "2026-07-31",
  reportAsOf: "2026-07-31T17:00:00-04:00",
  reportTimeZone: "Eastern Daylight Time (UTC-4)",
  reportIssuedAt: "2026-08-25T23:59:00-04:00",
  attestor: "KPMG LLP",
  engagement: "Independent accountants examination under AICPA attestation standards",
  conclusion: "unmodified",
  unit: "USD",
  // Latest (July 31) column only; earlier July 21 amounts are not additive.
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
    { label: "examined instant", pattern: /July 31, 2026 at 5:00\s+PM Eastern Time/ },
    { label: "assurance standard", pattern: /attestation standards established by the American Institute/ },
    { label: "unmodified conclusion", pattern: /In our opinion, Management.s Assertion is fairly stated, in all material respects/ },
    { label: "all tokens redeemable", pattern: /All USDP tokens are redeemable\. There are no temporary or permanent USDP nonredeemable tokens/ },
  ],
  rejectedText: [{ label: "qualified/adverse/disclaimed opinion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i }],
  reportedTotals: [
    { label: "Exhibit C redemption assets", expected: "31975703", pattern: /^\s*Redemption assets\s+\$?[0-9][0-9,]*\s+\$?([0-9][0-9,]*)\s*$/m },
    { label: "Exhibit C redeemable tokens", expected: "31954027", pattern: /^\s*Less: Amount of USDP redeemable tokens outstandingi\s+\$?[0-9][0-9,]*\s+\$?([0-9][0-9,]*)\s*$/m },
  ],
  reportedAssetTotal: "31975703",
  computedAssetTotal: "31975703",
  reportedLiabilityTotal: "31954027",
};
