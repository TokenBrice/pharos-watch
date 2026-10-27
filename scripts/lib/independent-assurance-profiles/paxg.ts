import { linePattern, type CompilerProfile } from "./shared";

export const PROFILE: CompilerProfile = {
  product: "PAXG",
  profile: "paxg-v1",
  officialIndexUrl: "https://www.paxos.com/paxg-transparency",
  reportUrl: "https://framerusercontent.com/assets/uwWybrLRlgkC4vexP3yLyrQVeV0.pdf",
  reportDate: "2026-09-30",
  reportAsOf: "2026-09-30T17:00:00-04:00",
  reportTimeZone: "Eastern Daylight Time (UTC-4)",
  reportIssuedAt: "2026-10-23T23:59:00-04:00",
  attestor: "KPMG LLP",
  engagement: "Independent accountants' examination under AICPA attestation standards",
  conclusion: "unmodified",
  unit: "fine-troy-ounce",
  assetRows: [
    { code: "allocated-gold", label: "London Good Delivery gold in fine troy ounces", pattern: linePattern("London Good Delivery gold in fine troy ounces of gold") },
  ],
  // Exhibit A columns: Ethereum, Solana, Robinhood and (from September 2026) Base.
  liabilityRows: [
    { code: "ethereum", label: "PAXG redeemable Ethereum tokens", pattern: /^\s*d\. Total PAXG redeemable tokens outstanding\s+(\d[\d,]*)\s+\d[\d,]*\s+\d[\d,]*\s+\d[\d,]*\s+\d[\d,]*\s*$/m },
    { code: "solana", label: "PAXG redeemable Solana tokens", pattern: /^\s*d\. Total PAXG redeemable tokens outstanding\s+\d[\d,]*\s+(\d[\d,]*)\s+\d[\d,]*\s+\d[\d,]*\s+\d[\d,]*\s*$/m },
    { code: "robinhood", label: "PAXG redeemable Robinhood tokens", pattern: /^\s*d\. Total PAXG redeemable tokens outstanding\s+\d[\d,]*\s+\d[\d,]*\s+(\d[\d,]*)\s+\d[\d,]*\s+\d[\d,]*\s*$/m },
    { code: "base", label: "PAXG redeemable Base tokens", pattern: /^\s*d\. Total PAXG redeemable tokens outstanding\s+\d[\d,]*\s+\d[\d,]*\s+\d[\d,]*\s+(\d[\d,]*)\s+\d[\d,]*\s*$/m },
  ],
  requiredText: [
    { label: "KPMG LLP", pattern: /KPMG LLP/ },
    { label: "September 30, 2026 report date", pattern: /September 30, 2026 at 5:00 PM Eastern Time/ },
    { label: "AICPA examination", pattern: /attestation standards established by the American Institute/ },
    { label: "favorable opinion", pattern: /In our opinion, Management.s Assertion is fairly stated, in all material respects/ },
    { label: "no nonredeemable tokens", pattern: /All PAXG tokens are redeemable\. There are no temporary or permanent PAXG nonredeemable tokens/ },
  ],
  rejectedText: [{ label: "qualified/adverse/disclaimed opinion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i }],
  reportedTotals: [
    { label: "PAXG gold assets", expected: "435306", pattern: linePattern("Total redemption assets in fine troy ounces of gold \\(Exhibit B\\)") },
    { label: "PAXG redeemable tokens", expected: "435306", pattern: linePattern("Total PAXG redeemable tokens outstanding \\(Exhibit A line d\\)") },
  ],
  reportedAssetTotal: "435306",
  computedAssetTotal: "435306",
  reportedLiabilityTotal: "435306",
};
