import { linePattern, type CompilerProfile } from "./shared";

export const PROFILE: CompilerProfile = {
  product: "AUDX",
  profile: "audx-v1",
  officialIndexUrl: "https://www.audxtoken.com/transparency",
  reportUrl: "https://www.audxtoken.com/_files/ugd/539754_e06dd9a1842d4b4a97777c64ed096bbe.pdf",
  reportDate: "2026-08-31",
  reportAsOf: "2026-08-31T23:59:00+11:00",
  reportTimeZone: "AEDT (as printed in the report; normalized conservatively to UTC)",
  attestor: "Aura Partners",
  engagement: "Independent limited assurance engagement under ASAE 3000 and ASAE 3100",
  conclusion: "nothing-came-to-attention",
  unit: "AUD",
  assetRows: [
    {
      code: "designated-bank-accounts",
      label: "Australian Dollar reserves held in designated TAU accounts",
      pattern: linePattern("TOTAL Australian Dollar Reserves"),
    },
  ],
  liabilityRows: [
    { code: "polygon", label: "Polygon AUDX supply", pattern: linePattern("Polygon") },
    { code: "ethereum", label: "Ethereum AUDX supply", pattern: linePattern("Ethereum") },
    { code: "conflux", label: "Conflux AUDX supply", pattern: linePattern("Conflux") },
    { code: "redbelly", label: "Redbelly AUDX supply", pattern: linePattern("Redbelly") },
    { code: "xdc", label: "XDC AUDX supply", pattern: linePattern("XDC") },
    { code: "ink", label: "Ink AUDX supply", pattern: linePattern("Ink") },
    { code: "solana", label: "Solana AUDX supply", pattern: linePattern("Solana") },
  ],
  requiredText: [
    { label: "Aura Partners", pattern: /AURAPARTNERS|Aura Partners/i },
    { label: "ASAE 3000", pattern: /ASAE 3000/i },
    { label: "ASAE 3100", pattern: /ASAE 3100/i },
    { label: "AUDX report date", pattern: /31(?:st)? of August 2026/i },
    { label: "favorable AUDX conclusion", pattern: /nothing has come to our[\s\S]*attention/i },
  ],
  rejectedText: [
    { label: "qualified/adverse/disclaimed conclusion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i },
  ],
  reportedTotals: [
    { label: "AUDX supply total", expected: "3498067.00", pattern: linePattern("TOTAL AUDX Supply") },
    { label: "AUDX reserve total", expected: "3521466.68", pattern: linePattern("TOTAL Australian Dollar Reserves") },
  ],
  reportedAssetTotal: "3521466.68",
  computedAssetTotal: "3521466.68",
  reportedLiabilityTotal: "3498067.00",
};
