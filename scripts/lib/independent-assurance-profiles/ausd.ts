import type { CompilerProfile } from "./shared";

export const PROFILE: CompilerProfile = {
  product: "AUSD",
  profile: "ausd-v1",
  officialIndexUrl: "https://docs.agora.finance/developer/transparency",
  reportUrl: "https://files.buildwithfern.com/agora.docs.buildwithfern.com/377372bfa35fa0c22ea1113fde44f99459f3c5f3dfa547bbf3ab692d71aac53d/docs/assets/2026%20Jul%20-%20Agora%20Dollar%20Reserve%20Report.pdf",
  reportDate: "2026-07-31",
  reportAsOf: "2026-07-31T23:59:00+00:00",
  reportTimeZone: "UTC (as printed in the report)",
  attestor: "Grant Thornton LLP",
  engagement: "Independent certified public accountants' examination under AICPA attestation standards",
  conclusion: "unmodified",
  unit: "USD",
  assetRows: [
    {
      code: "us-treasury-securities",
      label: "Short-dated U.S. Treasury securities held in the Agora Reserve Fund",
      pattern: /^\s*Total U\.S\. Treasury Securities\s+(61,365,065)\s*$/im,
    },
    {
      code: "us-treasury-repos",
      label: "Overnight U.S. Treasury repurchase agreements held in the Agora Reserve Fund",
      pattern: /^\s*U\.S\. Treasury Repurchase Agreements\s+(114,933,254)\s*$/im,
    },
    {
      code: "fund-cash",
      label: "Cash held in the Agora Reserve Fund at regulated financial institutions",
      pattern: /^\s*Cash held in the Agora Reserve Fund at regulated financial institutions\s+(10,510,374)\s*$/im,
    },
    {
      code: "company-cash",
      label: "Cash held by Agora Bermuda Limited at regulated financial institutions",
      pattern: /^\s*Cash held at regulated financial institutions\s+(48,604,476)\s*$/im,
    },
    {
      code: "stablecoins",
      label: "U.S. dollar stablecoins held in segregated wallets",
      pattern: /^\s*Stablecoins held in segregated wallets\s+(6,063,786)\s*$/im,
    },
  ],
  liabilityRows: [
    {
      code: "ausd-in-circulation",
      label: "AUSD in circulation across all AUSD Approved Blockchains",
      pattern: /^\s*AUSD\s+170,143,376\s+(240,745,867)\s*$/im,
    },
  ],
  adjustments: [
    {
      code: "ausd-created-excluded",
      label: "AUSD Created — minted but not yet distributed to third-party holders, excluded from AUSD in circulation",
      pattern: /^\s*Total\s+264,873,540\s+240,745,867\s+(24,127,673)\s*$/im,
      treatment:
        "Excluded from liabilities under the report's circulation criteria: AUSD Created that is solely custodied by the Company is not considered in circulation. Reported total supply 264,873,540 less excluded AUSD Created 24,127,673 equals 240,745,867 in circulation.",
    },
  ],
  requiredText: [
    { label: "Grant Thornton", pattern: /GRANT THORNTON/i },
    { label: "AICPA attestation standards", pattern: /American Institute of Certified Public Accountants/i },
    { label: "examined assertion", pattern: /We have examined management/i },
    { label: "July report dates in UTC", pattern: /11:59 PM Coordinated Universal/i },
    { label: "favorable AUSD conclusion", pattern: /fairly stated, in all material respects/i },
    { label: "signature date", pattern: /September 1, 2026/i },
  ],
  rejectedText: [
    { label: "qualified/adverse/disclaimed conclusion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i },
  ],
  reportedTotals: [
    { label: "July 31 reserve assets total", expected: "241476955", pattern: /^\s*170,450,045\s+(241,476,955)\s*$/im },
    { label: "July 31 AUSD in circulation", expected: "240745867", pattern: /^\s*AUSD\s+170,143,376\s+(240,745,867)\s*$/im },
    { label: "July 31 total supply", expected: "264873540", pattern: /^\s*Total\s+(264,873,540)\s+240,745,867\s+24,127,673\s*$/im },
    { label: "July 31 excluded AUSD Created", expected: "24127673", pattern: /^\s*Total\s+264,873,540\s+240,745,867\s+(24,127,673)\s*$/im },
    { label: "July 31 Treasury securities", expected: "61365065", pattern: /^\s*Total U\.S\. Treasury Securities\s+(61,365,065)\s*$/im },
    { label: "July 31 Treasury repos", expected: "114933254", pattern: /^\s*U\.S\. Treasury Repurchase Agreements\s+(114,933,254)\s*$/im },
  ],
  reportedAssetTotal: "241476955",
  computedAssetTotal: "241476955",
  reportedLiabilityTotal: "240745867",
};
