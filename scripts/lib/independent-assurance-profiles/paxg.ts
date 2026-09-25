import { linePattern, type CompilerProfile } from "./shared";

export const PROFILE: CompilerProfile = {
  product: "PAXG",
  profile: "paxg-v1",
  officialIndexUrl: "https://www.paxos.com/paxg-transparency",
  reportUrl: "https://framerusercontent.com/assets/9bk8TbTXouqOrpoxLSn5XIf7Ufo.pdf",
  reportDate: "2026-08-31",
  reportAsOf: "2026-08-31T17:00:00-04:00",
  reportTimeZone: "Eastern Daylight Time (UTC-4)",
  reportIssuedAt: "2026-09-24T23:59:00-04:00",
  attestor: "KPMG LLP",
  engagement: "Independent accountants' examination under AICPA attestation standards",
  conclusion: "unmodified",
  unit: "fine-troy-ounce",
  assetRows: [
    { code: "allocated-gold", label: "London Good Delivery gold in fine troy ounces", pattern: linePattern("London Good Delivery gold in fine troy ounces of gold") },
  ],
  // Exhibit A gained a Robinhood column (5 tokens) beside Ethereum and Solana.
  liabilityRows: [
    { code: "ethereum", label: "PAXG redeemable Ethereum tokens", pattern: /^\s*d\. Total PAXG redeemable tokens outstanding\s+(\d[\d,]*)\s+\d[\d,]*\s+\d[\d,]*\s+\d[\d,]*\s*$/m },
    { code: "solana", label: "PAXG redeemable Solana tokens", pattern: /^\s*d\. Total PAXG redeemable tokens outstanding\s+\d[\d,]*\s+(\d[\d,]*)\s+\d[\d,]*\s+\d[\d,]*\s*$/m },
    { code: "robinhood", label: "PAXG redeemable Robinhood tokens", pattern: /^\s*d\. Total PAXG redeemable tokens outstanding\s+\d[\d,]*\s+\d[\d,]*\s+(\d[\d,]*)\s+\d[\d,]*\s*$/m },
  ],
  requiredText: [
    { label: "KPMG LLP", pattern: /KPMG LLP/ },
    { label: "August 31, 2026 report date", pattern: /August 31, 2026 at 5:00 PM Eastern Time/ },
    { label: "AICPA examination", pattern: /attestation standards established by the American Institute/ },
    { label: "favorable opinion", pattern: /In our opinion, Management.s Assertion is fairly stated, in all material respects/ },
    { label: "no nonredeemable tokens", pattern: /All PAXG tokens are redeemable\. There are no temporary or permanent PAXG nonredeemable tokens/ },
  ],
  rejectedText: [{ label: "qualified/adverse/disclaimed opinion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i }],
  reportedTotals: [
    { label: "PAXG gold assets", expected: "431313", pattern: linePattern("Total redemption assets in fine troy ounces of gold \\(Exhibit B\\)") },
    { label: "PAXG redeemable tokens", expected: "431313", pattern: linePattern("Total PAXG redeemable tokens outstanding \\(Exhibit A line d\\)") },
  ],
  reportedAssetTotal: "431313",
  computedAssetTotal: "431313",
  reportedLiabilityTotal: "431313",
};
