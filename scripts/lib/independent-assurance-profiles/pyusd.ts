import type { CompilerProfile } from "./shared";

export const PROFILE: CompilerProfile = {
  product: "PYUSD",
  profile: "pyusd-v1",
  officialIndexUrl: "https://www.paxos.com/pyusd-transparency",
  reportUrl: "https://framerusercontent.com/assets/UZ8Eke3FvB5npXyceLEmiLRV6k.pdf",
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
    { code: "treasury-bills", label: "Obligations of U.S. Treasury, at fair value", pattern: /^\s*Obligations of U\.S\. Treasury, at fair value\s+\$?[0-9][0-9,]*\s+\$?([0-9][0-9,]*)\s*$/m },
  ],
  liabilityRows: [
    { code: "ethereum", label: "PYUSD redeemable ethereum tokens", pattern: /types of PYUSD tokens as of September 30, 2026[\s\S]*?Total PYUSD redeemable tokens\s+d\.\s+outstanding\s+([0-9][0-9,]*)\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s*$/m },
    { code: "solana", label: "PYUSD redeemable solana tokens", pattern: /types of PYUSD tokens as of September 30, 2026[\s\S]*?Total PYUSD redeemable tokens\s+d\.\s+outstanding\s+[0-9][0-9,]*\s+([0-9][0-9,]*)\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s*$/m },
    { code: "arbitrum", label: "PYUSD redeemable arbitrum tokens", pattern: /types of PYUSD tokens as of September 30, 2026[\s\S]*?Total PYUSD redeemable tokens\s+d\.\s+outstanding\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+([0-9][0-9,]*)\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s*$/m },
    { code: "stellar", label: "PYUSD redeemable stellar tokens", pattern: /types of PYUSD tokens as of September 30, 2026[\s\S]*?Total PYUSD redeemable tokens\s+d\.\s+outstanding\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+([0-9][0-9,]*)\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s*$/m },
    { code: "polygon", label: "PYUSD redeemable polygon tokens", pattern: /types of PYUSD tokens as of September 30, 2026[\s\S]*?Total PYUSD redeemable tokens\s+d\.\s+outstanding\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+([0-9][0-9,]*)\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s*$/m },
    { code: "ink", label: "PYUSD redeemable ink tokens", pattern: /types of PYUSD tokens as of September 30, 2026[\s\S]*?Total PYUSD redeemable tokens\s+d\.\s+outstanding\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+([0-9][0-9,]*)\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s*$/m },
    { code: "x-layer", label: "PYUSD redeemable x-layer tokens", pattern: /types of PYUSD tokens as of September 30, 2026[\s\S]*?Total PYUSD redeemable tokens\s+d\.\s+outstanding\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+([0-9][0-9,]*)\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s*$/m },
    { code: "stable", label: "PYUSD redeemable stable tokens", pattern: /types of PYUSD tokens as of September 30, 2026[\s\S]*?Total PYUSD redeemable tokens\s+d\.\s+outstanding\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+[0-9][0-9,]*\s+([0-9][0-9,]*)\s+[0-9][0-9,]*\s*$/m },
  ],
  requiredText: [
    { label: "KPMG LLP", pattern: /KPMG LLP/ },
    { label: "examined instant", pattern: /September 30,\s+2026 at 5:00\s+PM\s+Eastern\s+Time/ },
    { label: "assurance standard", pattern: /attestation standards established by the American Institute/ },
    { label: "unmodified conclusion", pattern: /In our opinion, Management.s Assertion is fairly stated, in all material respects/ },
    { label: "all tokens redeemable", pattern: /All PYUSD tokens are redeemable\. There are no temporary or permanent PYUSD nonredeemable tokens/ },
  ],
  rejectedText: [{ label: "qualified/adverse/disclaimed opinion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i }],
  reportedTotals: [
    { label: "Exhibit C redemption assets", expected: "2754709360", pattern: /^\s*Redemption assets\s+\$?[0-9][0-9,]*\s+\$?([0-9][0-9,]*)\s*$/m },
    { label: "Exhibit C redeemable tokens", expected: "2747625868", pattern: /^\s*Less: Amount of PYUSD redeemable tokens outstandingi\s+\$?[0-9][0-9,]*\s+\$?([0-9][0-9,]*)\s*$/m },
  ],
  reportedAssetTotal: "2754709360",
  computedAssetTotal: "2754709360",
  reportedLiabilityTotal: "2747625868",
};
