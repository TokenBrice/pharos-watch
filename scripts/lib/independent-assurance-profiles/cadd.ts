import { type CompilerProfile } from "./shared";

// Baker Tilly WM LLP's monthly CADD Reserve report carries two examined
// instants (e.g. September 16 and September 30, 2026). The September 30 columns are compiled
// as the reviewed report date; requiredText pins the second instant and the
// October 13, 2026 signature so a first-instant or later-month PDF cannot
// silently replace the reviewed figures.
export const PROFILE: CompilerProfile = {
  product: "CADD",
  profile: "cadd-v1",
  officialIndexUrl: "https://tetradg.com/cadd-reserve-attestations/",
  reportUrl: "https://drive.google.com/uc?export=download&id=1tMHO2EgZ6lRllAgp2h4BBanDTmGM1FBI&name=attestation.pdf",
  reportDate: "2026-09-30",
  reportAsOf: "2026-09-30T23:59:00Z",
  reportTimeZone: "UTC (as printed in the report)",
  reportIssuedAt: "2026-10-13T23:59:00Z",
  attestor: "Baker Tilly WM LLP",
  engagement: "Independent reasonable assurance engagement under Canadian Standard on Assurance Engagements (CSAE) 3000",
  conclusion: "unmodified",
  unit: "CAD",
  assetRows: [
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump.
    { code: "cad-cash", label: "Canadian Dollar Cash", pattern: /As of September 30, 2026[\s\S]*?Canadian Dollar Cash\s+100%\s+\$([0-9][0-9,]*(?:\.[0-9]+)?)/ },
  ],
  liabilityRows: [
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump.
    { code: "base-tempo-ethereum", label: "CADD in Circulation (Base, Tempo and Ethereum supply net of exclusions defined in the report)", pattern: /^\s*CADD in Circulation\s+[0-9][0-9,]*(?:\.[0-9]+)?\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s*$/im },
  ],
  requiredText: [
    { label: "Baker Tilly examiner", pattern: /Baker Tilly WM LLP/i },
    { label: "CSAE 3000 engagement", pattern: /CSAE\)\s*3000/i },
    { label: "September 30 examined instant", pattern: /September 30, 2026 11:59 p\.m\. Coordinated Universal Time/i },
    { label: "unmodified reasonable assurance opinion", pattern: /prepared, in all material respects, in accordance with the applicable\s+criteria/i },
    { label: "report signed October 13 2026", pattern: /October 13, 2026/i },
    { label: "circulation spans Base Tempo and Ethereum", pattern: /Base, Tempo and\s+Ethereum chains/i },
  ],
  rejectedText: [
    { label: "qualified/adverse/disclaimed conclusion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i },
    { label: "October report dates", pattern: /October [0-9]{1,2}, 2026 and October 31, 2026/i },
  ],
  reportedTotals: [
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump.
    { label: "September 30 total reserve assets", expected: "1320001.34", pattern: /As of September 30, 2026[\s\S]*?Total CADD Reserve Assets\s+100%\s+\$([0-9][0-9,]*(?:\.[0-9]+)?)/ },
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump.
    { label: "September 30 CADD in Circulation", expected: "1319658.34", pattern: /^\s*CADD in Circulation\s+[0-9][0-9,]*(?:\.[0-9]+)?\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s*$/im },
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump.
    { label: "September 30 Fair Value of Assets", expected: "1320001.34", pattern: /^\s*Fair Value of Assets\s+[0-9][0-9,]*(?:\.[0-9]+)?\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s*$/im },
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump.
    { label: "September 16 Fair Value of Assets", expected: "1305991.34", pattern: /^\s*Fair Value of Assets\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s+[0-9][0-9,]*(?:\.[0-9]+)?\s*$/im },
  ],
  reportedAssetTotal: "1320001.34",
  computedAssetTotal: "1320001.34",
  reportedLiabilityTotal: "1319658.34",
};
