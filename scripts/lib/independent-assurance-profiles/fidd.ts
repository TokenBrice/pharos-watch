import type { CompilerProfile } from "./shared";

// The July report examines two points in time (July 14 and July 31, 2026).
// The July 31 column is the reviewed snapshot; every row pattern below is
// anchored so it can only capture the July 31 column's printed value, and the
// requiredText guards pin both columns' distinct figures so any shift in
// either column breaks compilation.
//
// Extraction note: the layout text fragments heavily (letters and digits split
// across lines). The July 31 token count prints as "48,882," + newline + "278"
// (its fractional cent digits are clipped by the column gutter), so the token
// liability is captured from the July 14 column's contiguous "48,882,278" —
// both columns print the identical figure — while the guard
// `NumberofOut...FIDDTokens¹ ... 48,882,\n 278` proves the July 31 column
// prints the same value. The report's own reserve-surplus row is computed from
// a higher-precision token count than the columns display, so the displayed
// tokens and displayed surplus do not cross-check to the cent in the PDF
// itself; both printed figures are pinned as-is.
//
// The report's "Total Net Asset Value of the Reserve" ($51,386,438.77) nets a
// "$108,517.43 Net Other Assets (Liabilities)" bucket (earnings and settlement
// payables) against the gross cash + Treasury rows. The manifest carries the
// two gross asset rows exactly as printed; the NAV, net-other, and surplus
// figures are pinned via reportedTotals/requiredText guards.

export const PROFILE: CompilerProfile = {
  product: "FIDD",
  profile: "fidd-v1",
  officialIndexUrl: "https://www.fidelitydigitalassets.com/stablecoin",
  reportUrl: "https://fwc.widen.net/content/iizyowcatt/original/Fidelity-Digital-Assets---FIDD-Reserve-Attestation-Report---July26.pdf?u=zfczv1&download=true",
  reportDate: "2026-07-31",
  reportAsOf: "2026-07-31T17:00:00-04:00",
  reportTimeZone: "Eastern Daylight Time (UTC-4)",
  reportIssuedAt: "2026-08-26T23:59:00-04:00",
  attestor: "PricewaterhouseCoopers LLP",
  engagement: "Independent accountants' examination under AICPA attestation standards (AICPA 2025 Criteria for the Presentation and Disclosure of Redeemable Tokens Outstanding and the Availability of Assets for Redemption: Specific to Asset-Backed Fiat-Pegged Tokens)",
  conclusion: "unmodified",
  unit: "USD",
  assetRows: [
    {
      code: "cash-deposits",
      label: "Cash deposits held in bank deposit accounts at The Bank of New York Mellon (July 31 column)",
      pattern: /CashDepos\s+itsHeldinBankDepositAccounts\s+\$(20,860,119\.65)/,
    },
    {
      code: "us-treasury-bills",
      label: "U.S. Treasury bills (July 31 column)",
      pattern: /U\.S\.Treasur\s+yBil\s+ls\s+\$(30,634,836\.55)/,
    },
  ],
  liabilityRows: [
    {
      code: "ethereum",
      label: "FIDD redeemable Ethereum Mainnet tokens outstanding",
      pattern: /NumberofOut\s+standingFIDDTokens\s+¹\s+(48,882,278)/,
    },
  ],
  requiredText: [
    { label: "PricewaterhouseCoopers LLP", pattern: /PricewaterhouseCoopers/ },
    { label: "AICPA 2025 Criteria", pattern: /AICPA\) 2025 Criteria/ },
    { label: "favorable PwC opinion", pattern: /fairly stated, in all material respects/i },
    { label: "July 31 examined instant", pattern: /July 31, 2026, the last business day of the calendar month at 5:00 PM Eastern Time/ },
    { label: "July 14 examined instant", pattern: /July 14, 2026, a randomly selected business day/ },
    { label: "signature block", pattern: /Boston, Massachusetts\s+August 26, 2026/ },
    { label: "July 31 column header", pattern: /ASOFJ\s+ULY31,2026/ },
    { label: "July 14 column header", pattern: /ASOFJ\s+ULY14,2026/ },
    { label: "July 14 cash column", pattern: /\$20,569,068\.47/ },
    { label: "July 14 Treasury column", pattern: /\$30,861,529\.42/ },
    { label: "July 31 token column fragment", pattern: /48,882,\s+278/ },
    { label: "July 31 net-other bucket", pattern: /108,\s+517\.\s+43\)/ },
    { label: "July 14 net-other bucket", pattern: /44,\s+131\.\s+15\)/ },
  ],
  rejectedText: [
    { label: "qualified/adverse/disclaimed conclusion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i },
  ],
  reportedTotals: [
    {
      label: "July 31 Total Net Asset Value of the Reserve",
      expected: "51386438.77",
      pattern: /\$51,386,466\.74\s+TotalNetAs\s+setValueoftheRes\s+erve\s+\$(51,386,438\.77)/,
    },
    {
      label: "July 31 reserve surplus",
      expected: "2504160.49",
      pattern: /\$2,504,188\.46\s+Res\s+erveSurplus\S{0,2}\s+\$(2,504,160\.49)/,
    },
    {
      label: "July 31 outstanding FIDD tokens",
      expected: "48882278",
      pattern: /NumberofOut\s+standingFIDDTokens\s+¹\s+(48,882,278)/,
    },
  ],
  reportedAssetTotal: "51494956.20",
  computedAssetTotal: "51494956.20",
  reportedLiabilityTotal: "48882278",
};
