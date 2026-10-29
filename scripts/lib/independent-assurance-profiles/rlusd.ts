import { linePattern, type CompilerProfile } from "./shared";

export const PROFILE: CompilerProfile = {
  product: "RLUSD",
  profile: "rlusd-v1",
  officialIndexUrl: "https://ripple.com/products/stablecoin/transparency/",
  reportUrl: "https://cdn.sanity.io/files/ior4a5y3/production/850ed07e8f0556b3b1c1d43eb2a0fc4ef6538ce1.pdf/RLUSD%20Attestation%20Report%20(Sep)_Final%20Signed.pdf",
  reportDate: "2026-09-30",
  reportAsOf: "2026-09-30T21:00:00Z",
  reportTimeZone: "America/New_York (5:00pm Eastern Time; EDT, UTC-04:00)",
  reportIssuedAt: "2026-10-26T00:00:00Z",
  attestor: "Deloitte & Touche LLP",
  engagement: "AICPA attestation standards examination providing reasonable assurance over management’s RLUSD Reserve Report assertion, including reserve market value by asset class and outstanding stablecoin units",
  conclusion: "unmodified",
  unit: "USD",
  // Page five's asset table is an embedded image. These are its visually
  // reviewed September 30 column, not a fallback for a different report's bytes.
  reviewedImageExtraction: {
    reportSha256: "6b48bedc97423ed9bf9e5330a783ef4f7a386dd9571bd6648a2e01ce2e931db6",
    reportByteLength: 421946,
    normalizedTextSha256: "6555f57f22fabaf88be74f33f80f308e13d0b8b75a8321d9f1f6d1826d9000e4",
    pageCount: 5,
    tool: "Poppler pdftotext -layout; page 5 embedded image table read with Tesseract (eng) at 300% and reconciled to the printed text-layer totals",
    text: "Reviewed September 30 image column\nU.S. Treasury bills 1,693,595,956\nGovernment money-market funds 451,826,457\nCash and deposit accounts 378,585,861\nAdjustments due to timing (September 30) none\nImage total Market Value of the Reserve 2,524,008,274",
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
    { label: "RLUSD September report", pattern: /RLUSD Reserve Report\s+September 2026/ },
    { label: "Standard Custody issuer", pattern: /Standard Custody & Trust Company, LLC/ },
    { label: "examined instants", pattern: /September 21, 2026, and September 30, 2026, at 5:00pm Eastern Time/ },
    { label: "month-end column order", pattern: /September 21, 2026\s+September 30, 2026/ },
    { label: "AICPA examination", pattern: /attestation standards established by the American\s+Institute of Certified Public Accountants \(AICPA\)/ },
    { label: "favorable conclusion", pattern: /In our opinion,[\s\S]*?fairly stated, in all material respects/ },
    { label: "complete approved network scope", pattern: /NYDFS-approved blockchain networks include XRPL, Ethereum, Base, Unichain, Optimism, Ink, and the XRPL EVM Sidechain/ },
    { label: "signature date", pattern: /October 26, 2026/ },
  ],
  rejectedText: [{ label: "qualified/adverse/disclaimed opinion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i }],
  reportedTotals: [
    { label: "outstanding RLUSD", expected: "2399995528", pattern: /^\s*Outstanding Stablecoin Units\s+[0-9,]+\s+([0-9,]+)\s*$/m },
    { label: "market value of reserve", expected: "2524008274", pattern: /^\s*Market Value of the Reserve\s+\$[0-9,]+\s+\$([0-9,]+)\s*$/m },
    { label: "image reserve total", expected: "2524008274", pattern: linePattern("Image total Market Value of the Reserve") },
  ],
  reportedAssetTotal: "2524008274",
  computedAssetTotal: "2524008274",
  reportedLiabilityTotal: "2399995528",
};
