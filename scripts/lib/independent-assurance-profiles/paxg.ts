import { linePattern, type CompilerProfile } from "./shared";

export const PROFILE: CompilerProfile = {
  product: "PAXG",
  profile: "paxg-v1",
  officialIndexUrl: "https://www.paxos.com/paxg-transparency",
  reportUrl: "https://framerusercontent.com/assets/mZxm7J7vQTwbTmOGENYENSpEU.pdf",
  reportDate: "2026-07-31",
  reportAsOf: "2026-07-31T17:00:00-04:00",
  reportTimeZone: "Eastern Daylight Time (UTC-4)",
  reportIssuedAt: "2026-08-25T23:59:00-04:00",
  attestor: "KPMG LLP",
  engagement: "Independent accountants' examination under AICPA attestation standards",
  conclusion: "unmodified",
  unit: "fine-troy-ounce",
  assetRows: [
    { code: "allocated-gold", label: "London Good Delivery gold in fine troy ounces", pattern: linePattern("London Good Delivery gold in fine troy ounces of gold") },
  ],
  liabilityRows: [
    { code: "ethereum", label: "PAXG redeemable Ethereum tokens", pattern: /^\s*d\. Total PAXG redeemable tokens outstanding\s+(\d[\d,]*)\s+\d[\d,]*\s+\d[\d,]*\s*$/m },
    { code: "solana", label: "PAXG redeemable Solana tokens", pattern: /^\s*d\. Total PAXG redeemable tokens outstanding\s+\d[\d,]*\s+(\d[\d,]*)\s+\d[\d,]*\s*$/m },
  ],
  requiredText: [
    { label: "KPMG LLP", pattern: /KPMG LLP/ },
    { label: "July 31, 2026 report date", pattern: /July 31, 2026 at 5:00 PM Eastern Time/ },
    { label: "AICPA examination", pattern: /attestation standards established by the American Institute/ },
    { label: "favorable opinion", pattern: /In our opinion, Management.s Assertion is fairly stated, in all material respects/ },
    { label: "no nonredeemable tokens", pattern: /All PAXG tokens are redeemable\. There are no temporary or permanent PAXG nonredeemable tokens/ },
  ],
  rejectedText: [{ label: "qualified/adverse/disclaimed opinion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i }],
  reportedTotals: [
    { label: "PAXG gold assets", expected: "442217", pattern: linePattern("Total redemption assets in fine troy ounces of gold \\(Exhibit B\\)") },
    { label: "PAXG redeemable tokens", expected: "442217", pattern: linePattern("Total PAXG redeemable tokens outstanding \\(Exhibit A line d\\)") },
  ],
  reportedAssetTotal: "442217",
  computedAssetTotal: "442217",
  reportedLiabilityTotal: "442217",
};
