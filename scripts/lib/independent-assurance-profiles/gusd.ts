import type { CompilerProfile } from "./shared";

export const PROFILE: CompilerProfile = {
  product: "GUSD",
  profile: "gusd-v1",
  // Gemini publishes its monthly attestations through a public Contentful
  // delivery collection (space jg6lo9a2ukvr, content_type=gusdAttestation,
  // newest first) that powers the /dollar attestation list. The delivery token
  // is public client-bundle configuration, not a secret, and is the reviewed
  // official index. Newest entry: September 30, 2026, resolving to the BPM
  // examination signed October 29, 2026 below.
  officialIndexUrl: "https://cdn.contentful.com/spaces/jg6lo9a2ukvr/entries?access_token=AIRFWcFNIs83Nw7SKtdz1wLW9j94yxYlS5ef5qHGo8A&content_type=gusdAttestation&order=-fields.reportDate&limit=1000&include=1",
  reportUrl: "https://assets.ctfassets.net/jg6lo9a2ukvr/3HYXlAhHtWfLDSCry4eiyI/d7096b458d345243a4aa786b6bb86c6e/Gemini_Trust_Company__LLC_-_GUSD_Reserves_Report_September_2026_-_Issued.pdf",
  reportDate: "2026-09-30",
  reportAsOf: "2026-09-30T17:00:00-04:00",
  reportTimeZone: "Eastern Daylight Time (UTC-4)",
  attestor: "BPM LLP",
  engagement: "Independent accountants' examination under AICPA attestation standards",
  conclusion: "unmodified",
  unit: "USD",
  // The Reserve (market value) is gross cash deposits less a net timing and
  // settlement difference. Reported totals must equal the asset sum, so the
  // net reserve is the asset row and the gross/receivable bridge is pinned via
  // reportedTotals and recorded as an adjustment. Latest (September 30) column only.
  assetRows: [
    {
      code: "cash-deposits",
      label: "Cash deposits held at U.S. regulated financial institutions, net of timing and settlement differences",
      pattern: /^\s*Total Reserve\s+\$?\s*[0-9][0-9,]*\.[0-9]+\s+\$?\s*([0-9][0-9,]*\.[0-9]+)\s*$/m,
    },
  ],
  adjustments: [
    {
      code: "net-cash-receivable",
      alreadyNettedIntoAssets: true,
      label: "Net cash receivable (payable) due to timing and settlement differences",
      treatment: "Deducted from gross cash deposits to arrive at the reported Total Reserve",
      pattern: /Net cash receivable \(payable\) due to\s*\n\s*\d*\s*timing and settlement differences\s*\d*\s+\([0-9][0-9,]*\.[0-9]+\)\s+(\([0-9][0-9,]*\.[0-9]+\))/,
    },
  ],
  // GUSD is issued natively on Ethereum; the NEAR contract is a bridged
  // representation of the same units, so one row covers every chain.
  liabilityRows: [
    { code: "ethereum", label: "GUSD issued and in circulation", pattern: /^\s*GUSD issued and in circulation\d*\s+\$?[0-9][0-9,]*\.[0-9]+\s+([0-9][0-9,]*\.[0-9]+)\s*$/m },
  ],
  requiredText: [
    { label: "BPM letterhead", pattern: /bpm\.com|bpm@bpm\.com/ },
    { label: "examined instants", pattern: /as of September 9, 2026, and as of September 30, 2026/ },
    { label: "AICPA attestation standards", pattern: /attestation standards established by the American Institute of\s+Certified Public Accountants/ },
    { label: "unmodified opinion", pattern: /In our opinion, Management.s Assertion that the Company complied with the requirements of item 3\(a\) of the DFS\s+Letter as of September 9, 2026, and as of September 30, 2026, is fairly stated, in all material respects/ },
    { label: "5pm Eastern end of day", pattern: /5pm Eastern Time/ },
    { label: "NYDFS DFS letter", pattern: /New York\s+State Department of Financial Services/ },
    { label: "examined column order", pattern: /^\s*September 9, 2026\s+September 30, 2026\s*$/m },
    { label: "negative settlement pair", pattern: /timing and settlement differences\s*\d*\s+\([\d,]+\.\d+\)\s+\([\d,]+\.\d+\)/ },
  ],
  rejectedText: [
    { label: "qualified/adverse/disclaimed conclusion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i },
  ],
  reportedTotals: [
    {
      label: "cash deposits (September 30)",
      expected: "39246582.59",
      pattern: /Cash deposits held at U\.S\. regulated\s*\n\s*financial institutions\s+\$\s*[0-9][0-9,]*\.[0-9]+\s+\$\s*([0-9][0-9,]*\.[0-9]+)/,
    },
    {
      label: "net settlement difference (September 30)",
      expected: "-867828.19",
      pattern: /Net cash receivable \(payable\) due to\s*\n\s*\d*\s*timing and settlement differences\s*\d*\s+\([0-9][0-9,]*\.[0-9]+\)\s+(\([0-9][0-9,]*\.[0-9]+\))/,
    },
    {
      label: "Total Reserve",
      expected: "38378754.40",
      pattern: /^\s*Total Reserve\s+\$?\s*[0-9][0-9,]*\.[0-9]+\s+\$?\s*([0-9][0-9,]*\.[0-9]+)\s*$/m,
    },
    { label: "GUSD issued and in circulation", expected: "38378754.40", pattern: /^\s*GUSD issued and in circulation\d*\s+\$?[0-9][0-9,]*\.[0-9]+\s+([0-9][0-9,]*\.[0-9]+)\s*$/m },
  ],
  reportedAssetTotal: "38378754.40",
  computedAssetTotal: "38378754.40",
  reportedLiabilityTotal: "38378754.40",
  // Parenthesized figures denote the net payable; normalize to a signed decimal.
  normalizeAmount: (raw) => {
    const negative = raw.startsWith("(") && raw.endsWith(")");
    const digits = raw.replace(/[$,()]/g, "");
    return negative ? `-${digits}` : digits;
  },
};
