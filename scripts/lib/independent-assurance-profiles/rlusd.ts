import { linePattern, type CompilerProfile } from "./shared";

export const PROFILE: CompilerProfile = {
  product: "RLUSD",
  profile: "rlusd-v1",
  officialIndexUrl: "https://ripple.com/products/stablecoin/transparency/",
  reportUrl: "https://cdn.sanity.io/files/ior4a5y3/production/4981331c98a2bb203c0c9ab2584e8b2a0da80938.pdf/RLUSD%20Attestation%20Report%20(Aug)_Final%20Signed.pdf",
  reportDate: "2026-08-31",
  reportAsOf: "2026-08-31T21:00:00Z",
  reportTimeZone: "America/New_York (5:00pm Eastern Time; EDT, UTC-04:00)",
  reportIssuedAt: "2026-09-29T00:00:00Z",
  attestor: "Deloitte & Touche LLP",
  engagement: "AICPA attestation standards examination providing reasonable assurance over management’s RLUSD Reserve Report assertion, including reserve market value by asset class and outstanding stablecoin units",
  conclusion: "unmodified",
  unit: "USD",
  // Page five's asset table is an embedded image. These are its visually
  // reviewed August 31 column, not a fallback for a different report's bytes.
  reviewedImageExtraction: {
    reportSha256: "a3d1ec0687bacf92016c3ffa3eff6de8ccb64f529aa17635521fba59615fab7f",
    reportByteLength: 558025,
    normalizedTextSha256: "2714f0f61135fa671313c727c74d89c82168d8e361a1879b2227288e805d0178",
    pageCount: 5,
    tool: "Poppler pdftotext -layout; page 5 embedded table visually transcribed from rendered PDF",
    text: "Reviewed August 31 image column\nU.S. Treasury bills 1,557,070,479\nGovernment money-market funds 467,625,232\nCash and deposit accounts 421,617,153\nImage total Market Value of the Reserve 2,446,312,864",
  },
  assetRows: [
    { code: "treasury-bills", label: "U.S. Treasury bills", pattern: linePattern("U\\.S\\. Treasury bills") },
    { code: "government-mmf", label: "Government money-market funds", pattern: linePattern("Government money-market funds") },
    { code: "cash", label: "Cash and deposit accounts", pattern: linePattern("Cash and deposit accounts") },
  ],
  liabilityRows: [
    { code: "outstanding-rlusd", label: "Outstanding RLUSD across NYDFS-approved XRPL, Ethereum, Base, Unichain, Optimism, Ink and XRPL EVM Sidechain networks", pattern: /^\s*Outstanding Stablecoin Units\s+[0-9,]+\s+([0-9,]+)\s*$/m },
  ],
  requiredText: [
    { label: "RLUSD August report", pattern: /RLUSD Reserve Report\s+August 2026/ },
    { label: "Standard Custody issuer", pattern: /Standard Custody & Trust Company, LLC/ },
    { label: "examined instants", pattern: /August 17, 2026, and August 31, 2026, at 5:00pm Eastern Time/ },
    { label: "month-end column order", pattern: /August 17, 2026\s+August 31, 2026/ },
    { label: "AICPA examination", pattern: /attestation standards established by the American\s+Institute of Certified Public Accountants \(AICPA\)/ },
    { label: "favorable conclusion", pattern: /In our opinion,[\s\S]*?fairly stated, in all material respects/ },
    { label: "complete approved network scope", pattern: /NYDFS-approved blockchain networks include XRPL, Ethereum, Base, Unichain, Optimism, Ink, and the XRPL EVM Sidechain/ },
    { label: "signature date", pattern: /September 29, 2026/ },
  ],
  rejectedText: [{ label: "qualified/adverse/disclaimed opinion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i }],
  reportedTotals: [
    { label: "outstanding RLUSD", expected: "2325969308", pattern: /^\s*Outstanding Stablecoin Units\s+[0-9,]+\s+([0-9,]+)\s*$/m },
    { label: "market value of reserve", expected: "2446312864", pattern: /^\s*Market Value of the Reserve\s+\$[0-9,]+\s+\$([0-9,]+)\s*$/m },
    { label: "image reserve total", expected: "2446312864", pattern: linePattern("Image total Market Value of the Reserve") },
  ],
  reportedAssetTotal: "2446312864",
  computedAssetTotal: "2446312864",
  reportedLiabilityTotal: "2325969308",
};
