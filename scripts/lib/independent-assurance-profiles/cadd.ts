import { type CompilerProfile } from "./shared";

// Baker Tilly WM LLP's monthly CADD Reserve report carries two examined
// instants (e.g. July 28 and July 31, 2026). The July 31 columns are compiled
// as the reviewed report date; requiredText pins the second instant and the
// September 4, 2026 signature so a first-instant or later-month PDF cannot
// silently replace the reviewed figures.
export const PROFILE: CompilerProfile = {
  product: "CADD",
  profile: "cadd-v1",
  officialIndexUrl: "https://tetradg.com/cadd-reserve-attestations/",
  reportUrl: "https://drive.google.com/uc?export=download&id=19cuC3Y91BCr1AopeCfzq53oZJD7HeEET&name=attestation.pdf",
  reportDate: "2026-07-31",
  reportAsOf: "2026-07-31T23:59:00Z",
  reportTimeZone: "UTC (as printed in the report)",
  reportIssuedAt: "2026-09-04T23:59:00Z",
  attestor: "Baker Tilly WM LLP",
  engagement: "Independent reasonable assurance engagement under Canadian Standard on Assurance Engagements (CSAE) 3000",
  conclusion: "unmodified",
  unit: "CAD",
  assetRows: [
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump.
    { code: "cad-cash", label: "Canadian Dollar Cash", pattern: /As of July 31, 2026[\s\S]*?Canadian Dollar Cash\s+100%\s+\$([0-9][0-9,]*(?:\.[0-9]+)?)/ },
  ],
  liabilityRows: [
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump.
    { code: "base-tempo-ethereum", label: "CADD in Circulation (total CADD token supply on the Base, Tempo and Ethereum chains)", pattern: /^\s*CADD in Circulation\s+[0-9][0-9,]*(?:\.[0-9]+)?\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s*$/im },
  ],
  requiredText: [
    { label: "Baker Tilly examiner", pattern: /Baker Tilly WM LLP/i },
    { label: "CSAE 3000 engagement", pattern: /CSAE\)\s*3000/i },
    { label: "July 31 examined instant", pattern: /July 31, 2026 11:59 p\.m\. Coordinated Universal Time/i },
    { label: "unmodified reasonable assurance opinion", pattern: /prepared, in all material respects, in accordance with the applicable criteria/i },
    { label: "report signed September 4 2026", pattern: /September 4, 2026/i },
    { label: "circulation spans Base Tempo and Ethereum", pattern: /Base, Tempo and\s+Ethereum chains/i },
  ],
  rejectedText: [
    { label: "qualified/adverse/disclaimed conclusion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i },
    { label: "August report dates", pattern: /August [0-9]{1,2}, 2026 and August 31, 2026/i },
  ],
  reportedTotals: [
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump.
    { label: "July 31 total reserve assets", expected: "1194448.5", pattern: /As of July 31, 2026[\s\S]*?Total CADD Reserve Assets\s+100%\s+\$([0-9][0-9,]*(?:\.[0-9]+)?)/ },
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump.
    { label: "July 31 CADD in Circulation", expected: "1188399.38", pattern: /^\s*CADD in Circulation\s+[0-9][0-9,]*(?:\.[0-9]+)?\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s*$/im },
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump.
    { label: "July 31 Fair Value of Assets", expected: "1194448.5", pattern: /^\s*Fair Value of Assets\s+[0-9][0-9,]*(?:\.[0-9]+)?\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s*$/im },
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump.
    { label: "July 28 Fair Value of Assets", expected: "1192757.38", pattern: /^\s*Fair Value of Assets\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s+[0-9][0-9,]*(?:\.[0-9]+)?\s*$/im },
  ],
  reportedAssetTotal: "1194448.5",
  computedAssetTotal: "1194448.5",
  reportedLiabilityTotal: "1188399.38",
};
