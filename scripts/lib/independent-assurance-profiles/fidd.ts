import type { CompilerProfile } from "./shared";

// Pin the September 30 column; Poppler splits its digits across layout lines.
// Gross cash plus Treasuries exclude the separately pinned $97,502.49 net liabilities.
// Keep the printed whole-token count; NAV minus surplus implies $0.45 less.

export const PROFILE: CompilerProfile = {
  product: "FIDD",
  profile: "fidd-v1",
  officialIndexUrl: "https://www.fidelitydigitalassets.com/stablecoin",
  reportUrl: "https://fwc.widen.net/content/azzc1igqzr/original/Fidelity-Digital-Assets---FIDD-Reserve-Attestation-Report---September-2026.pdf?u=5lvvtn&download=true",
  reportDate: "2026-09-30",
  reportAsOf: "2026-09-30T17:00:00-04:00",
  reportTimeZone: "Eastern Daylight Time (UTC-4)",
  reportIssuedAt: "2026-10-26T23:59:00-04:00",
  attestor: "PricewaterhouseCoopers LLP",
  engagement: "Independent accountants' examination under AICPA attestation standards (AICPA 2025 Criteria for the Presentation and Disclosure of Redeemable Tokens Outstanding and the Availability of Assets for Redemption: Specific to Asset-Backed Fiat-Pegged Tokens)",
  conclusion: "unmodified",
  unit: "USD",
  normalizeAmount: (raw) => raw.replace(/[$,\s]/g, ""),
  assetRows: [
    {
      code: "cash-deposits",
      label: "Cash deposits held in bank deposit accounts at The Bank of New York Mellon (September 30 column)",
      pattern: /Cas\s+hDepos\s+itsHel\s+dinBankDepos\s+itAccount\s+s\s+\$(20,\s+789,\s+144\.\s+46)/,
    },
    {
      code: "us-treasury-bills",
      label: "U.S. Treasury bills (September 30 column)",
      pattern: /U\.\s+S\.Tr\s+eas\s+uryBi\s+ll\s+s\s+\$(31,\s+252,\s+677\.\s+97)/,
    },
  ],
  liabilityRows: [
    {
      code: "ethereum",
      label: "FIDD redeemable Ethereum Mainnet tokens outstanding",
      pattern: /NumberofOut\s+standingFI\s+DDTokens\s+¹\s+(49,440,\s+407)/,
    },
  ],
  requiredText: [
    { label: "PricewaterhouseCoopers LLP", pattern: /PricewaterhouseCoopers/ },
    { label: "AICPA 2025 Criteria", pattern: /AICPA\) 2025 Criteria/ },
    { label: "favorable PwC opinion", pattern: /fairly stated, in all material respects/i },
    { label: "September 30 examined instant", pattern: /September 30, 2026, the last business day of the calendar month at 5:00 PM Eastern Time/ },
    { label: "September 3 examined instant", pattern: /September 3, 2026, a randomly selected business day/ },
    { label: "signature block", pattern: /Boston, Massachusetts\s+October 26, 2026/ },
    { label: "September 30 column header", pattern: /ASOFSEPTEMBER30,2026/ },
    { label: "September 3 column header", pattern: /ASOFSEPTEMBER3,2026/ },
    { label: "September 3 cash column", pattern: /\$20,\s+917,\s+948\.\s+34/ },
    { label: "September 3 Treasury column", pattern: /\$31,\s+086,\s+461\.\s+11/ },
    { label: "September 30 token column fragment", pattern: /49,440,\s+407/ },
    { label: "September 30 net-other bucket", pattern: /97,\s+502\.\s+49\)/ },
    { label: "September 3 net-other bucket", pattern: /9,\s+434\.\s+61\)/ },
  ],
  rejectedText: [
    { label: "qualified/adverse/disclaimed conclusion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i },
  ],
  reportedTotals: [
    {
      label: "September 30 Total Net Asset Value of the Reserve",
      expected: "51944319.94",
      pattern: /\$51,994,974\.84\s+TotalNetAs\s+setValueoftheRes\s+erve\s+\$(51,944,319\.94)/,
    },
    {
      label: "September 30 reserve surplus",
      expected: "2503912.49",
      pattern: /\$2,504,615\.89\s+Res\s+erveSurplus\S{0,2}\s+\$(2,503,912\.49)/,
    },
    {
      label: "September 30 outstanding FIDD tokens",
      expected: "49440407",
      pattern: /NumberofOut\s+standingFI\s+DDTokens\s+¹\s+(49,440,\s+407)/,
    },
  ],
  reportedAssetTotal: "52041822.43",
  computedAssetTotal: "52041822.43",
  reportedLiabilityTotal: "49440407",
};
