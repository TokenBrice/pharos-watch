import { type CompilerProfile } from "./shared";

export const PROFILE: CompilerProfile = {
  product: "AUDD",
  profile: "audd-v1",
  officialIndexUrl: "https://www.audd.digital/transparency/",
  reportUrl: "https://www.audd.digital/wp-content/uploads/2026/11/202610_AUDC-Agreed-upon-procedures-report-Oct26_.pdf",
  reportDate: "2026-10-31",
  reportAsOf: "2026-10-31T23:59:00Z",
  reportTimeZone: "UTC (as printed in the report)",
  reportIssuedAt: "2026-11-10T23:59:00Z",
  attestor: "William Buck Audit (Vic) Pty Ltd",
  engagement: "Report of Factual Findings under ASRS 4400 Agreed-Upon Procedures Engagements (not an assurance engagement)",
  conclusion: "agreed-upon-procedures",
  unit: "AUD",
  assetRows: [
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump.
    { code: "banking-circle", label: "AUD cash held at Banking Circle (AUDC Reserve Account)", pattern: /^\s*Acc:\s+XX9639\s+100% cash\s+\$?([0-9][0-9,]*(?:\.[0-9]+)?)\b/im },
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump.
    { code: "westpac", label: "AUD cash held at Westpac under the AMAL Bare Trust", pattern: /^\s*Acc:\s+XXXX-XX6566\s+100% cash\s+\$?([0-9][0-9,]*(?:\.[0-9]+)?)\b/im },
  ],
  liabilityRows: [
    // October's amounts precede their chain labels; Stellar/XRP labels share reserve-account lines.
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump.
    { code: "stellar", label: "Stellar AUDD circulation", pattern: /^\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*\nAcc:\s+XX9639\s+100% cash\s+\$?[0-9][0-9,]*(?:\.[0-9]+)?\s+Stellar\s*$/im },
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump.
    { code: "xrpl", label: "XRP Ledger AUDD circulation", pattern: /^\s*Value at Westpac\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s*\nAcc:\s+XXXX-XX6566\s+100% cash\s+\$?[0-9][0-9,]*(?:\.[0-9]+)?\s+XRP Ledger\s*$/im },
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump.
    { code: "ethereum", label: "Ethereum AUDD circulation", pattern: /^\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*\n\s*Ethereum\s*$/im },
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump.
    { code: "solana", label: "Solana AUDD circulation", pattern: /^\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*\n\s*Solana\s*$/im },
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump.
    { code: "hedera", label: "Hedera AUDD circulation", pattern: /^\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*\n\s*Hedera\s*$/im },
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump.
    { code: "base", label: "Base AUDD circulation", pattern: /^\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*\n\s*Base\s*$/im },
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump.
    { code: "xdc", label: "XDC AUDD circulation", pattern: /^\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*\n\s*XDC\s*$/im },
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump.
    { code: "redbelly", label: "Redbelly AUDD circulation", pattern: /^\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*\n\s*Redbelly\s*$/im },
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump.
    { code: "arc", label: "ARC AUDD circulation", pattern: /^\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*\n\s*ARC\s*$/im },
  ],
  requiredText: [
    { label: "William Buck examiner", pattern: /William Buck Audit \(Vic\) Pty Ltd/i },
    { label: "ASRS 4400 engagement", pattern: /ASRS 4400/i },
    { label: "examined instant", pattern: /11:59pm UTC on 31\s*st October 2026/i },
    { label: "AUP is not an assurance engagement", pattern: /not an assurance engagement/i },
    { label: "factual finding reserves at minimum equal onchain", pattern: /minimum equal to the AUDD[\s\S]*?Onchain amounts/i },
  ],
  rejectedText: [
    { label: "qualified/adverse/disclaimed conclusion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i },
  ],
  reportedTotals: [
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump.
    { label: "AUDD reserve account total", expected: "9213478.78", pattern: /^\s*Total:\s+\$?([0-9][0-9,]*(?:\.[0-9]+)?)\s+[0-9][0-9,]*(?:\.[0-9]+)?\s*$/im },
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump.
    { label: "AUDD on-chain total", expected: "9088311.70", pattern: /^\s*Total:\s+\$?[0-9][0-9,]*(?:\.[0-9]+)?\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s*$/im },
  ],
  reportedAssetTotal: "9213478.78",
  computedAssetTotal: "9213478.78",
  reportedLiabilityTotal: "9088311.70",
};
