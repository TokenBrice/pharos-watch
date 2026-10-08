import type { CompilerProfile } from "./shared";

export const PROFILE: CompilerProfile = {
  product: "GUSD",
  profile: "gusd-v1",
  // Gemini publishes its monthly attestations through a public Contentful
  // delivery collection (space jg6lo9a2ukvr, content_type=gusdAttestation,
  // newest first) that powers the /dollar attestation list. The delivery token
  // is public client-bundle configuration, not a secret, and is the reviewed
  // official index. Newest entry: August 31, 2026, resolving to the BPM
  // examination signed October 6, 2026 below.
  officialIndexUrl: "https://cdn.contentful.com/spaces/jg6lo9a2ukvr/entries?access_token=AIRFWcFNIs83Nw7SKtdz1wLW9j94yxYlS5ef5qHGo8A&content_type=gusdAttestation&order=-fields.reportDate&limit=1000&include=1",
  reportUrl: "https://assets.ctfassets.net/jg6lo9a2ukvr/7m6P0Or1IDsjF8Nj71yoOY/aff37499c0d462e444c5e614ed065e79/Gemini_Trust_Company__LLC_-_GUSD_RR_August_2026_-_Issued.pdf",
  reportDate: "2026-08-31",
  reportAsOf: "2026-08-31T17:00:00-04:00",
  reportTimeZone: "Eastern Daylight Time (UTC-4)",
  attestor: "BPM LLP",
  engagement: "Independent accountants' examination under AICPA attestation standards",
  conclusion: "unmodified",
  unit: "USD",
  // The Reserve (market value) is gross cash deposits less a net timing and
  // settlement difference. Reported totals must equal the asset sum, so the
  // net reserve is the asset row and the gross/receivable bridge is pinned via
  // reportedTotals and recorded as an adjustment. Latest (August 31) column only.
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
      pattern: /Net cash receivable \(payable\) due to\s*\n\s*\d*\s*timing and settlement differences\s+\([0-9][0-9,]*\.[0-9]+\)\s+(\([0-9][0-9,]*\.[0-9]+\))/,
    },
  ],
  // GUSD is issued natively on Ethereum; the NEAR contract is a bridged
  // representation of the same units, so one row covers every chain.
  liabilityRows: [
    { code: "ethereum", label: "GUSD issued and in circulation", pattern: /^\s*GUSD issued and in circulation\d*\s+\$?[0-9][0-9,]*\.[0-9]+\s+([0-9][0-9,]*\.[0-9]+)\s*$/m },
  ],
  requiredText: [
    { label: "BPM letterhead", pattern: /bpm\.com|bpm@bpm\.com/ },
    { label: "examined instants", pattern: /as of August 11, 2026, and as of August 31, 2026/ },
    { label: "AICPA attestation standards", pattern: /attestation standards established by the American Institute of\s+Certified Public Accountants/ },
    { label: "unmodified opinion", pattern: /In our opinion, Management.s Assertion that the Company complied with the requirements of item 3\(a\) of the DFS\s+Letter as of August 11, 2026, and as of August 31, 2026, is fairly stated, in all material respects/ },
    { label: "5pm Eastern end of day", pattern: /5pm Eastern Time/ },
    { label: "NYDFS DFS letter", pattern: /New York\s+State Department of Financial Services/ },
    { label: "examined column order", pattern: /^\s*August 11, 2026\s+August 31, 2026\s*$/m },
    { label: "negative settlement pair", pattern: /timing and settlement differences\s+\([\d,]+\.\d+\)\s+\([\d,]+\.\d+\)/ },
  ],
  rejectedText: [
    { label: "qualified/adverse/disclaimed conclusion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i },
  ],
  reportedTotals: [
    {
      label: "cash deposits (August 31)",
      expected: "40344765.86",
      pattern: /Cash deposits held at U\.S\. regulated\s*\n\s*financial institutions\s+\$\s?[0-9][0-9,]*\.[0-9]+\s+\$\s?([0-9][0-9,]*\.[0-9]+)/,
    },
    {
      label: "net settlement difference (August 31)",
      expected: "-770884.86",
      pattern: /Net cash receivable \(payable\) due to\s*\n\s*\d*\s*timing and settlement differences\s+\([0-9][0-9,]*\.[0-9]+\)\s+(\([0-9][0-9,]*\.[0-9]+\))/,
    },
    {
      label: "Total Reserve",
      expected: "39573881.00",
      pattern: /^\s*Total Reserve\s+\$?\s*[0-9][0-9,]*\.[0-9]+\s+\$?\s*([0-9][0-9,]*\.[0-9]+)\s*$/m,
    },
    { label: "GUSD issued and in circulation", expected: "39573881.00", pattern: /^\s*GUSD issued and in circulation\d*\s+\$?[0-9][0-9,]*\.[0-9]+\s+([0-9][0-9,]*\.[0-9]+)\s*$/m },
  ],
  reportedAssetTotal: "39573881.00",
  computedAssetTotal: "39573881.00",
  reportedLiabilityTotal: "39573881.00",
  // Parenthesized figures denote the net payable; normalize to a signed decimal.
  normalizeAmount: (raw) => {
    const negative = raw.startsWith("(") && raw.endsWith(")");
    const digits = raw.replace(/[$,()]/g, "");
    return negative ? `-${digits}` : digits;
  },
};
