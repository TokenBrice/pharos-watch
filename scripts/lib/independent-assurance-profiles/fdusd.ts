import type { CompilerProfile } from "./shared";

export const PROFILE: CompilerProfile = {
  product: "FDUSD",
  profile: "fdusd-v1",
  officialIndexUrl: "https://firstdigitallabs.webflow.io/transparency",
  reportUrl: "https://cdn.prod.website-files.com/675ab99bf1f7ea944d49a55b/6a866c81428740395febba47_B1-07-%20ISAE3000%20-%20Attestation%20Report%20on%20Reserves%20Account%20July%202026)%20-%20Draft.pdf",
  reportDate: "2026-07-31",
  reportAsOf: "2026-07-31T21:00:00-04:00",
  reportTimeZone: "Eastern Time (daylight saving, UTC-4; the report also prints 1 August 2026 at 9:00am HKT)",
  attestor: "AOGB CPA Limited",
  engagement: "Independent limited assurance engagement under ISAE 3000 (Revised) issued by the IAASB",
  conclusion: "nothing-came-to-attention",
  unit: "USD",
  assetRows: [
    {
      code: "treasury-bills",
      label: "United States Treasury Bills (seven maturities, 11-Aug-26 through 22-Sep-26)",
      // eslint-disable-next-line security/detect-unsafe-regex -- anchored pattern over an offline reviewed PDF text dump; bounded digit runs, no nested quantifier ambiguity.
      pattern: /\(A\) Sub-total:\s+([\d,]+(?:\.\d{2})?)/,
    },
    {
      code: "fixed-deposits",
      label: "U.S. government guaranteed fixed deposits held pursuant to reserve repurchase agreements",
      // eslint-disable-next-line security/detect-unsafe-regex -- anchored pattern over an offline reviewed PDF text dump; bounded digit runs, no nested quantifier ambiguity.
      pattern: /\(B\) Sub-total:\s+([\d,]+(?:\.\d{2})?)/,
    },
    {
      code: "custody-cash",
      label: "US$ held in custody accounts",
      // eslint-disable-next-line security/detect-unsafe-regex -- anchored pattern over an offline reviewed PDF text dump; bounded digit runs, no nested quantifier ambiguity.
      pattern: /\(C\) US\$ held in custody accounts:\s+([\d,]+(?:\.\d{2})?)/,
    },
  ],
  liabilityRows: [
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored pattern over an offline reviewed PDF text dump; bounded digit runs, no nested quantifier ambiguity.
    { code: "ethereum", label: "Ethereum FDUSD supply", pattern: /([\d,]+(?:\.\d{2})?) in Ethereum\)/ },
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored pattern over an offline reviewed PDF text dump; bounded digit runs, no nested quantifier ambiguity.
    { code: "bsc", label: "BSC FDUSD supply", pattern: /([\d,]+(?:\.\d{2})?) in BSC/ },
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored pattern over an offline reviewed PDF text dump; bounded digit runs, no nested quantifier ambiguity.
    { code: "sui", label: "Sui FDUSD supply", pattern: /([\d,]+(?:\.\d{2})?) FDUSD in SUI/ },
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored pattern over an offline reviewed PDF text dump; bounded digit runs, no nested quantifier ambiguity.
    { code: "solana", label: "Solana FDUSD supply", pattern: /([\d,]+(?:\.\d{2})?) FDUSD in SOL/ },
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored pattern over an offline reviewed PDF text dump; bounded digit runs, no nested quantifier ambiguity.
    { code: "arbitrum", label: "Arbitrum FDUSD supply", pattern: /([\d,]+(?:\.\d{2})?) FDUSD in Arbitrum/ },
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored pattern over an offline reviewed PDF text dump; bounded digit runs, no nested quantifier ambiguity.
    { code: "ton", label: "TON FDUSD supply", pattern: /([\d,]+(?:\.\d{2})?) FDUSD in TON/ },
  ],
  requiredText: [
    { label: "AOGB CPA Limited", pattern: /AOGB CPA Limited/ },
    { label: "ISAE 3000 (Revised)", pattern: /International Standard on Assurance Engagements 3000 \(Revised\)/ },
    { label: "limited assurance", pattern: /limited assurance/i },
    { label: "report date and time", pattern: /31 July 2026 at 9:00pm Eastern Time/ },
    { label: "HKT cross-reference", pattern: /1 August 2026 at 9:00am Hong Kong Time/ },
    { label: "independent limited assurance conclusion", pattern: /independent limited assurance conclusion/ },
    { label: "favorable conclusion", pattern: /nothing has come to our attention[\s\S]*?not prepared, in all material respects/ },
  ],
  rejectedText: [
    { label: "qualified/adverse/disclaimed conclusion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i },
  ],
  reportedTotals: [
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored pattern over an offline reviewed PDF text dump; bounded digit runs, no nested quantifier ambiguity.
    { label: "FDUSD reserve accounts total", expected: "351643471.73", pattern: /\(A\) \+ \(B\) \+ \(C\) Total assets held in Reserve Accounts:\s+US\$?([\d,]+(?:\.\d{2})?)/ },
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored pattern over an offline reviewed PDF text dump; bounded digit runs, no nested quantifier ambiguity.
    { label: "FDUSD supply total", expected: "350156619.24", pattern: /issued and in circulation[\s\S]{0,300}?([\d,]+(?:\.\d{2})?) FDUSD/ },
  ],
  reportedAssetTotal: "351643471.73",
  computedAssetTotal: "351643471.73",
  reportedLiabilityTotal: "350156619.24",
};
