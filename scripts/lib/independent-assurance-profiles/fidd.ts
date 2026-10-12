import type { CompilerProfile } from "./shared";

// Pin the August 31 column; Poppler splits its digits across layout lines.
// Gross cash plus Treasuries exclude the separately pinned $97,070.46 net liabilities.
// Keep the printed whole-token count; NAV minus surplus implies $0.15 less.

export const PROFILE: CompilerProfile = {
  product: "FIDD",
  profile: "fidd-v1",
  officialIndexUrl: "https://www.fidelitydigitalassets.com/stablecoin",
  reportUrl: "https://fwc.widen.net/content/z6rtnzs3v9/original/Fidelity-Digital-Assets---FIDD-Reserve-Attestation-Report---August-2026.pdf?u=5lvvtn&download=true",
  reportDate: "2026-08-31",
  reportAsOf: "2026-08-31T17:00:00-04:00",
  reportTimeZone: "Eastern Daylight Time (UTC-4)",
  reportIssuedAt: "2026-09-25T23:59:00-04:00",
  attestor: "PricewaterhouseCoopers LLP",
  engagement: "Independent accountants' examination under AICPA attestation standards (AICPA 2025 Criteria for the Presentation and Disclosure of Redeemable Tokens Outstanding and the Availability of Assets for Redemption: Specific to Asset-Backed Fiat-Pegged Tokens)",
  conclusion: "unmodified",
  unit: "USD",
  normalizeAmount: (raw) => raw.replace(/[$,\s]/g, ""),
  assetRows: [
    {
      code: "cash-deposits",
      label: "Cash deposits held in bank deposit accounts at The Bank of New York Mellon (August 31 column)",
      pattern: /Cas\s+hDepos\s+itsHel\s+dinBankDepos\s+itAccount\s+s\s+\$(20,\s+717,\s+851\.\s+25)/,
    },
    {
      code: "us-treasury-bills",
      label: "U.S. Treasury bills (August 31 column)",
      pattern: /U\.\s+S\.Tr\s+eas\s+uryBi\s+ll\s+s\s+\$(31,\s+173,\s+738\.\s+08)/,
    },
  ],
  liabilityRows: [
    {
      code: "ethereum",
      label: "FIDD redeemable Ethereum Mainnet tokens outstanding",
      pattern: /NumberofOut\s+standingFI\s+DDTokens\s+¹\s+(49,290,\s+319)/,
    },
  ],
  requiredText: [
    { label: "PricewaterhouseCoopers LLP", pattern: /PricewaterhouseCoopers/ },
    { label: "AICPA 2025 Criteria", pattern: /AICPA\) 2025 Criteria/ },
    { label: "favorable PwC opinion", pattern: /fairly stated, in all material respects/i },
    { label: "August 31 examined instant", pattern: /August 31, 2026, the last business day of the calendar month at 5:00 PM Eastern Time/ },
    { label: "August 7 examined instant", pattern: /August 7, 2026, a randomly selected business day/ },
    { label: "signature block", pattern: /Boston, Massachusetts\s+September 25, 2026/ },
    { label: "August 31 column header", pattern: /ASOFAUGUST31,2026/ },
    { label: "August 7 column header", pattern: /ASOFAUGUST7,2026/ },
    { label: "August 7 cash column", pattern: /\$20,\s+094,\s+180\.\s+45/ },
    { label: "August 7 Treasury column", pattern: /\$30,\s+788,\s+925\.\s+46/ },
    { label: "August 31 token column fragment", pattern: /49,290,\s+319/ },
    { label: "August 31 net-other bucket", pattern: /97,\s+070\.\s+46\)/ },
    { label: "August 7 net-other bucket", pattern: /28,\s+021\.\s+35\)/ },
  ],
  rejectedText: [
    { label: "qualified/adverse/disclaimed conclusion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i },
  ],
  reportedTotals: [
    {
      label: "August 31 Total Net Asset Value of the Reserve",
      expected: "51794518.87",
      pattern: /\$50,855,084\.56\s+TotalNetAs\s+setValueoftheRes\s+erve\s+\$(51,794,518\.87)/,
    },
    {
      label: "August 31 reserve surplus",
      expected: "2504200.02",
      pattern: /\$2,504,781\.58\s+Res\s+erveSurplus\S{0,2}\s+\$(2,504,200\.02)/,
    },
    {
      label: "August 31 outstanding FIDD tokens",
      expected: "49290319",
      pattern: /NumberofOut\s+standingFI\s+DDTokens\s+¹\s+(49,290,\s+319)/,
    },
  ],
  reportedAssetTotal: "51891589.33",
  computedAssetTotal: "51891589.33",
  reportedLiabilityTotal: "49290319",
};
