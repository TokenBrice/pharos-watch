import type { CompilerProfile } from "./shared";

export const PROFILE: CompilerProfile = {
  product: "AUSD",
  profile: "ausd-v1",
  officialIndexUrl: "https://docs.agora.finance/developer/transparency",
  reportUrl: "https://files.buildwithfern.com/agora.docs.buildwithfern.com/03ab55af3875dc0420487b38025944f2b379390770d4403b5ea987dec7b5e412/docs/assets/2026%20Sep%20-%20Agora%20Dollar%20Reserve%20Report.pdf",
  reportDate: "2026-09-30",
  reportAsOf: "2026-09-30T23:59:00+00:00",
  reportTimeZone: "UTC (as printed in the report)",
  reportIssuedAt: "2026-10-30T23:59:00Z",
  attestor: "Grant Thornton LLP",
  engagement: "Independent certified public accountants' examination under AICPA attestation standards",
  conclusion: "unmodified",
  unit: "USD",
  assetRows: [
    {
      code: "us-treasury-securities",
      label: "Short-dated U.S. Treasury securities held in the Agora Reserve Fund",
      pattern: /^\s*Total U\.S\. Treasury Securities\s+(74,173,595)\s*$/im,
    },
    {
      code: "us-treasury-repos",
      label: "Overnight U.S. Treasury repurchase agreements held in the Agora Reserve Fund",
      pattern: /^\s*U\.S\. Treasury Repurchase Agreements\s+(114,569,743)\s*$/im,
    },
    {
      code: "fund-cash",
      label: "Cash held in the Agora Reserve Fund at regulated financial institutions",
      pattern: /^\s*Cash held in the Agora Reserve Fund at regulated financial institutions\s+(989)\s*$/im,
    },
    {
      code: "company-cash",
      label: "Cash held by Agora Bermuda Limited at regulated financial institutions",
      pattern: /^\s*Cash held at regulated financial institutions\s+(28,200,822)\s*$/im,
    },
    {
      code: "stablecoins",
      label: "U.S. dollar stablecoins held in segregated wallets",
      pattern: /^\s*Stablecoins held in segregated wallets\s+(2,209,214)\s*$/im,
    },
  ],
  liabilityRows: [
    {
      code: "ausd-in-circulation",
      label: "AUSD in circulation across all AUSD Approved Blockchains",
      pattern: /^\s*Total\s+250,554,813\s+(218,359,166)\s+32,195,647\s*$/im,
    },
  ],
  adjustments: [
    {
      code: "ausd-created-excluded",
      kind: "excluded-circulation",
      label: "AUSD Created: minted but not distributed, excluded from circulation",
      pattern: /^\s*Total\s+250,554,813\s+218,359,166\s+(32,195,647)\s*$/im,
      treatment: "Total supply 250,554,813 less AUSD Created solely custodied by the Company 32,195,647 equals 218,359,166 in circulation. This is excluded circulation, not an asset-netting adjustment.",
    },
  ],
  requiredText: [
    { label: "Grant Thornton", pattern: /GRANT THORNTON/i },
    { label: "AICPA attestation standards", pattern: /American Institute of Certified Public Accountants/i },
    { label: "examined assertion", pattern: /We have examined management/i },
    { label: "September report dates in UTC", pattern: /September 23, and September 30, 2026, at 11:59 PM\s+Coordinated/i },
    { label: "favorable AUSD conclusion", pattern: /fairly stated, in all material respects/i },
    { label: "signature date", pattern: /October 30, 2026/i },
  ],
  rejectedText: [
    { label: "qualified/adverse/disclaimed conclusion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i },
  ],
  reportedTotals: [
    { label: "September 30 reserve assets total", expected: "219154364", pattern: /^\s*September 30, 2026\s+(219,154,364)\s*$/im },
    { label: "September 30 fund subtotal", expected: "188744328", pattern: /^\s*(188,744,328)\s*$/im },
    { label: "September 30 AUSD in circulation", expected: "218359166", pattern: /^\s*Total\s+250,554,813\s+(218,359,166)\s+32,195,647\s*$/im },
    { label: "September 30 total supply", expected: "250554813", pattern: /^\s*Total\s+(250,554,813)\s+218,359,166\s+32,195,647\s*$/im },
    { label: "September 30 excluded AUSD Created", expected: "32195647", pattern: /^\s*Total\s+250,554,813\s+218,359,166\s+(32,195,647)\s*$/im },
    { label: "September 30 Treasury securities", expected: "74173595", pattern: /^\s*Total U\.S\. Treasury Securities\s+(74,173,595)\s*$/im },
    { label: "September 30 Treasury repos", expected: "114569743", pattern: /^\s*U\.S\. Treasury Repurchase Agreements\s+(114,569,743)\s*$/im },
  ],
  reportedAssetTotal: "219154364",
  computedAssetTotal: "219154363",
  reportedLiabilityTotal: "218359166",
};
