import type { CompilerProfile } from "./shared";

export const PROFILE: CompilerProfile = {
  product: "USDG",
  profile: "usdg-v1",
  officialIndexUrl: "https://www.paxos.com/usdg-transparency",
  reportUrl: "https://framerusercontent.com/assets/IJR7RhuqfckbBnl7fVubmqrnc.pdf",
  reportDate: "2026-07-31",
  reportAsOf: "2026-07-31T17:00:00-04:00",
  reportTimeZone: "Eastern Daylight Time (UTC-4)",
  reportIssuedAt: "2026-08-26T23:59:00+08:00",
  attestor: "KPMG LLP",
  engagement: "Independent reasonable assurance under Singapore Standard on Assurance Engagements 3000",
  conclusion: "unmodified",
  unit: "USD",
  // Latest (July 31) column only; earlier July 21 amounts are not additive.
  assetRows: [
    { code: "cash", label: "Cash", pattern: /^\s*Cash\s+\$?[0-9][0-9,]*\s+\$?([0-9][0-9,]*)\s*$/m },
    { code: "government-mmf", label: "Government money market funds, at net asset value", pattern: /^\s*Government money market funds, at\s+\$[\d,]+\s+\$([\d,]+)\s+net asset value\s*$/m },
    { code: "treasury-bills", label: "Obligations of U.S. Treasury, at fair value", pattern: /^\s*Obligations of U\.S\. Treasury, at fair\s+\$[\d,]+\s+\$([\d,]+)\s+value\s*$/m },
  ],
  // Exhibit A is image-only. Its six-chain total is also printed in Exhibit C.
  liabilityRows: [
    { code: "all-native-chains", label: "USDG redeemable tokens: Ethereum, Solana, Ink, X Layer, Arbitrum One and Robinhood (Exhibit A total carried to Exhibit C)", pattern: /^\s*Less: Amount of USDG redeemable tokens outstandingi\s+\$?[0-9][0-9,]*\s+\$?([0-9][0-9,]*)\s*$/m },
  ],
  requiredText: [
    { label: "KPMG LLP", pattern: /KPMG LLP/ },
    { label: "examined instant", pattern: /31 July 2026 at 5:00 PM United States Eastern/ },
    { label: "assurance standard", pattern: /Singapore Standard on Assurance Engagements 3000/ },
    { label: "unmodified conclusion", pattern: /In our opinion, the Management.s Assertion has been properly stated[\s\S]*?in all material respects/ },
    { label: "all tokens redeemable", pattern: /All USDG tokens are redeemable\. There are no temporary or permanent USDG nonredeemable tokens/ },
  ],
  rejectedText: [{ label: "qualified/adverse/disclaimed opinion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i }],
  reportedTotals: [
    { label: "Exhibit C redemption assets", expected: "3404876225", pattern: /^\s*Redemption assets\s+\$?[0-9][0-9,]*\s+\$?([0-9][0-9,]*)\s*$/m },
    { label: "Exhibit C redeemable tokens", expected: "3400474143", pattern: /^\s*Less: Amount of USDG redeemable tokens outstandingi\s+\$?[0-9][0-9,]*\s+\$?([0-9][0-9,]*)\s*$/m },
  ],
  reportedAssetTotal: "3404876225",
  computedAssetTotal: "3404876225",
  reportedLiabilityTotal: "3400474143",
};
