import { linePattern, type CompilerProfile } from "./shared";

// The July 2026 MCCPA report examines management's assertion that the fair
// value of SBC reserve assets equals or exceeds SBC issued as of July 31,
// 2026 at 11:50pm Eastern Time. The report carries a material source
// limitation — MCCPA "was not retained to, and has not attempted to,
// independently confirm the authenticity and accuracy" of company-provided
// data and records — which is preserved verbatim in the engagement field and
// requiredText guards rather than hidden. The report nonetheless expresses an
// unmodified examination opinion on management's assertion under AICPA direct
// examination standards, so the manifest conclusion remains an independent
// examination ("unmodified").

export const PROFILE: CompilerProfile = {
  product: "SBC",
  profile: "sbc-v1",
  officialIndexUrl: "https://brale.xyz/stablecoins/SBC",
  reportUrl: "https://brale.xyz/assets/reports/SBC-Stable-Coin-Reserve-Attestation-Report-07-2026.pdf",
  reportDate: "2026-07-31",
  reportAsOf: "2026-07-31T23:50:00-04:00",
  reportTimeZone: "Eastern Daylight Time (UTC-4)",
  reportIssuedAt: "2026-08-11T23:59:00-05:00",
  attestor: "Michael Coglianese, CPA, P.C. (MCCPA)",
  engagement: "AICPA attestation standards direct examination of management's assertion; MCCPA relied on data and records provided by Brale Inc. and was not retained to, and has not attempted to, independently confirm the authenticity and accuracy of those data and records",
  conclusion: "unmodified",
  unit: "USD",
  assetRows: [
    {
      code: "cash-and-cash-equivalents",
      label: "Cash and cash equivalents in unencumbered segregated accounts",
      pattern: linePattern("Cash and cash equivalents"),
    },
    {
      code: "us-government-backed-debt",
      label: "U.S. government backed debt",
      pattern: linePattern("US government backed debt"),
    },
  ],
  liabilityRows: [
    {
      code: "all-supported-blockchains",
      label: "SBC issued across all supported blockchains (Algorand, Aptos, Arbitrum, Avalanche, Base, Canton, Celo, Chia, Coreum, Ethereum, Ethereum Classic, Hedera, Kusama, Monad, Optimism, Polygon, PulseChain, Radius, Solana, Spark, Starknet, Stellar, Tron, Tempo, World Chain, XRP Ledger, Xion)",
      pattern: linePattern("SBC Issued"),
    },
  ],
  requiredText: [
    { label: "MCCPA examiner", pattern: /Michael Coglianese|MCCPA/ },
    { label: "AICPA direct examination", pattern: /attestation standards for a direct examination/i },
    { label: "favorable MCCPA opinion", pattern: /fairly stated, in all material respects/i },
    { label: "report date", pattern: /July 31, 2026,? at 11:50pm Eastern Time/ },
    { label: "signature block", pattern: /Lincolnshire, IL\s+August 11, 2026/ },
    { label: "examiner source limitation", pattern: /independently confirm the authenticity/i },
    { label: "supported blockchains", pattern: /Supported Blockchains/i },
  ],
  rejectedText: [
    { label: "qualified/adverse/disclaimed conclusion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i },
  ],
  reportedTotals: [
    {
      label: "Fair Value of Reserve Assets",
      expected: "6723679",
      pattern: linePattern("Fair Value of Reserve Assets"),
    },
    {
      label: "SBC Issued",
      expected: "6723679",
      pattern: linePattern("SBC Issued"),
    },
  ],
  reportedAssetTotal: "6723679",
  computedAssetTotal: "6723679",
  reportedLiabilityTotal: "6723679",
};
