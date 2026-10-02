import { type CompilerProfile } from "./shared";

const AUD_AMOUNT = "([0-9][0-9,]*(?:\\.[0-9]+)?)";

export const PROFILE: CompilerProfile = {
  product: "AUDM",
  profile: "audm-v1",
  officialIndexUrl: "https://www.macropod.com/transparency",
  reportUrl: "https://cdn.prod.website-files.com/69df87da28d300c1b443a0d6/6abf4aae214c978251192bb2_261001%20Catena%20Digital%20Pty%20Ltd%20Reserve%20Verification%20Report%20as%20at%2030th%20Sept%202026.pdf",
  reportDate: "2026-09-30",
  reportAsOf: "2026-09-30T23:59:59+10:00",
  reportTimeZone: "Australian Eastern Standard Time (AEST, UTC+10)",
  attestor: "Catena Digital Pty Ltd (trading as Macropod Global) — issuer CEO",
  engagement:
    "Issuer self-attestation under paragraph 12 of ASIC Corporations (Stablecoin and Wrapped Token Relief) Instrument 2025/867; not an independent examination",
  conclusion: "issuer-attested",
  unit: "AUD",
  assetRows: [
    {
      code: "cash",
      label: "Cash held at Westpac Banking Corporation in the AUDM Trust Class A Reserve",
      pattern: new RegExp(`Cash\\s+\\$${AUD_AMOUNT}`),
    },
  ],
  liabilityRows: [
    { code: "ethereum", label: "Ethereum AUDM on-chain supply", pattern: new RegExp(`Ethereum\\s+\\$${AUD_AMOUNT}`) },
    { code: "redbelly", label: "Redbelly AUDM on-chain supply", pattern: new RegExp(`Redbelly\\s+\\$${AUD_AMOUNT}`) },
    { code: "solana", label: "Solana AUDM on-chain supply", pattern: new RegExp(`Solana\\s+\\$${AUD_AMOUNT}`) },
    { code: "base", label: "Base AUDM on-chain supply", pattern: new RegExp(`Base\\s+\\$${AUD_AMOUNT}`) },
  ],
  requiredText: [
    { label: "Catena Digital", pattern: /Catena Digital/ },
    { label: "Westpac", pattern: /Westpac Banking Corporation/ },
    { label: "ASIC 2025/867", pattern: /Stablecoin and\s+Wrapped Token Relief/ },
    { label: "1:1 ratio", pattern: /1:1 ratio/ },
    { label: "AUDM report date", pattern: /30th September 2026/ },
    { label: "CEO signature", pattern: /CEO/ },
  ],
  rejectedText: [
    { label: "qualified/adverse/disclaimed conclusion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i },
  ],
  reportedTotals: [
    { label: "AUDM reserve total", expected: "3322783.88", pattern: new RegExp(`Total Reserve Accounts AUD\\s+\\$${AUD_AMOUNT}`) },
    { label: "AUDM on-chain total", expected: "3322070.88", pattern: new RegExp(`Total AUDM\\s+\\$${AUD_AMOUNT}`) },
  ],
  reportedAssetTotal: "3322783.88",
  computedAssetTotal: "3322783.88",
  reportedLiabilityTotal: "3322070.88",
};
