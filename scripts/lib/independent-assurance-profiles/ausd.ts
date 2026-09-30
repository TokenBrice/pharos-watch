import type { CompilerProfile } from "./shared";

export const PROFILE: CompilerProfile = {
  product: "AUSD",
  profile: "ausd-v1",
  officialIndexUrl: "https://docs.agora.finance/developer/transparency",
  reportUrl: "https://files.buildwithfern.com/agora.docs.buildwithfern.com/444c4f3a9642d6a9149e8fa9736469cd03192f55cc7ff3d2326117b0397875b5/docs/assets/2026%20Aug%20-%20Agora%20Dollar%20Reserve%20Report.pdf",
  reportDate: "2026-08-31",
  reportAsOf: "2026-08-31T23:59:00+00:00",
  reportTimeZone: "UTC (as printed in the report)",
  reportIssuedAt: "2026-09-29T23:59:00Z",
  attestor: "Grant Thornton LLP",
  engagement: "Independent certified public accountants' examination under AICPA attestation standards",
  conclusion: "unmodified",
  unit: "USD",
  assetRows: [
    {
      code: "us-treasury-securities",
      label: "Short-dated U.S. Treasury securities held in the Agora Reserve Fund",
      pattern: /^\s*Total U\.S\. Treasury Securities\s+(72,739,998)\s*$/im,
    },
    {
      code: "us-treasury-repos",
      label: "Overnight U.S. Treasury repurchase agreements held in the Agora Reserve Fund",
      pattern: /^\s*U\.S\. Treasury Repurchase Agreements\s+(109,979,730)\s*$/im,
    },
    {
      code: "fund-cash",
      label: "Cash held in the Agora Reserve Fund at regulated financial institutions",
      pattern: /^\s*Cash held in the Agora Reserve Fund at regulated financial institutions\s+(3,498,929)\s*$/im,
    },
    {
      code: "company-cash",
      label: "Cash held by Agora Bermuda Limited at regulated financial institutions",
      pattern: /^\s*Cash held at regulated financial institutions\s+(47,880,812)\s*$/im,
    },
    {
      code: "stablecoins",
      label: "U.S. dollar stablecoins held in segregated wallets",
      pattern: /^\s*Stablecoins held in segregated wallets\s+(4,990,986)\s*$/im,
    },
  ],
  liabilityRows: [
    {
      code: "ausd-in-circulation",
      label: "AUSD in circulation across all AUSD Approved Blockchains",
      pattern: /^\s*Total\s+266,520,420\s+(238,379,206)\s+28,141,214\s*$/im,
    },
  ],
  adjustments: [
    {
      code: "ausd-created-excluded",
      kind: "excluded-circulation",
      label: "AUSD Created: minted but not distributed, excluded from circulation",
      pattern: /^\s*Total\s+266,520,420\s+238,379,206\s+(28,141,214)\s*$/im,
      treatment: "Total supply 266,520,420 less AUSD Created solely custodied by the Company 28,141,214 equals 238,379,206 in circulation. This is excluded circulation, not an asset-netting adjustment.",
    },
  ],
  requiredText: [
    { label: "Grant Thornton", pattern: /GRANT THORNTON/i },
    { label: "AICPA attestation standards", pattern: /American Institute of Certified Public Accountants/i },
    { label: "examined assertion", pattern: /We have examined management/i },
    { label: "August report dates in UTC", pattern: /August 12, and August 31, 2026, at 11:59 PM Coordinated/i },
    { label: "favorable AUSD conclusion", pattern: /fairly stated, in all material respects/i },
    { label: "signature date", pattern: /September 29, 2026/i },
  ],
  rejectedText: [
    { label: "qualified/adverse/disclaimed conclusion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i },
  ],
  reportedTotals: [
    { label: "August 31 reserve assets total", expected: "239090456", pattern: /^\s*214,346,495\s+(239,090,456)\s*$/im },
    { label: "August 31 AUSD in circulation", expected: "238379206", pattern: /^\s*Total\s+266,520,420\s+(238,379,206)\s+28,141,214\s*$/im },
    { label: "August 31 total supply", expected: "266520420", pattern: /^\s*Total\s+(266,520,420)\s+238,379,206\s+28,141,214\s*$/im },
    { label: "August 31 excluded AUSD Created", expected: "28141214", pattern: /^\s*Total\s+266,520,420\s+238,379,206\s+(28,141,214)\s*$/im },
    { label: "August 31 Treasury securities", expected: "72739998", pattern: /^\s*Total U\.S\. Treasury Securities\s+(72,739,998)\s*$/im },
    { label: "August 31 Treasury repos", expected: "109979730", pattern: /^\s*U\.S\. Treasury Repurchase Agreements\s+(109,979,730)\s*$/im },
  ],
  reportedAssetTotal: "239090456",
  computedAssetTotal: "239090455",
  reportedLiabilityTotal: "238379206",
};
