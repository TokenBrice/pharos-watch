import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const SAFETY_SCORE_V10: readonly MethodologyChangelogEntry[] = [
  {
    version: "10.0",
    title: "V10: curation, owner rulings, and physical-to-USD Exit",
    date: "2026-10-01",
    effectiveAt: 1790812800,
    summary:
      "V10 is a major release consolidating the 2026-10-01 curation pass, owner rulings, and physical-to-USD Exit. It brings known-supply Exit sizing, whole-book custody and report-date discipline, measured collateralization, deployment-local control pricing, adverse mint evidence continuity, wrapper and inheritance corrections, and reviewed physical-metal redemption composed with conservative USD sales. Missing evidence never grants credit.",
    impact: [
      "The Exit-only supply projection admits a bounded-unknown supply fact only when its required policy rule is v9.supply.bridge-materiality, the producer's marker that the current amount is established but its partition is not. Known supply keeps its existing behavior, and the reviewed stress fraction, grid, cost bound, and settlement horizon are unchanged.",
      "Missing bridge profiles, ambiguous route joins, and missing or rejected attribution packets no longer suppress Exit sizing when a current circulating amount is established. No bridge shares, chain distribution, transfer materiality, control facts, or evidence gaps are inferred or promoted; their existing gaps and ceilings remain.",
      "Sizing is not executable-capacity evidence: every route still needs the existing same-notional capacity, output valuation, cost, access, and settlement admission. Exit and downstream scores may change where measured routes can now be compared, without guaranteeing a grade improvement.",
      "Asset-wide institutional custody labels now require whole-book evidence. Custody gains mixed and unknown values; omitted custody for centralized or RWA-backed classes defaults to unknown instead of an institutional label, while structural on-chain defaults remain. Mixed and unknown never qualify for regulated-only or on-chain-only Selector eligibility and add no numeric Safety Score credit.",
      "Explicitly adapter-owned reserve compositions keep their own date when a separately evidenced monthly report has a known period end and publication date. Curated-only compositions keep report-period lockstep, audit-grade admission still requires matching periods, and independently dated fallback rows retain only their own static-validated evidence, completeness, and freshness gates.",
      "A reviewed per-asset field withholds favorable parent Backing inheritance for a branded strategy token with an undisclosed mixed book (sUSD1+ from USD1) while keeping the serial adverse cap, price, supply, peg, and lifecycle relationships.",
      "Security history gains an informational record for disclosed, remediated, non-realized vulnerabilities (USD3 batch auction, XAUT transferFrom, fxUSD router), dated from primary disclosures, with no realized-exploit, loss, or mint-incident routing.",
      "Direct serial wrappers whose own authored custody is on-chain stay outside wrapper-local custody and rehypothecation scoring, so upstream custody uncertainty is not charged twice; legal safeguards are never granted and parent inheritance is unchanged.",
      "Mint-control selection prices the worst applicable durable-mint authority across deployments: native root issuance stays asset-wide, and proved deployment-local controls keep supply-weighted treatment.",
      "Privileged-pricing ceilings are removed while the oracle Control component retains its 45-point bound. Evidence-backed adverse mint findings survive unresolved reviews until positive evidence clears them.",
      "A reserve report without an explicit publication date may use its exact printed signed or as-of date as a typed, visibly signed conservative publication stand-in. Chronology, report age, composition lockstep, and assurance-scope gates remain; no later date is invented.",
      "Unresolved deployment-local controls price proportionally in Economic Control only when admitted aggregate exposure, including unattributed remainder, is below the existing 10% materiality threshold. Material or unknown exposure retains whole-coin ceilings, and the deduction is disclosed separately.",
      "An admitted measured collateralization ratio below 100% caps Backing, including inherited reserve quality. LVUSD's documented uncovered liability share receives zero credit; absent or solvent measurements grant no benefit.",
      "Reviewed physical-metal redemption can compose with conservative modelled USD sales. Admission enforces lot arithmetic, a physical-only 500-bps cost limit, expiry, captured prices, lower-confidence fee and timing assumptions, and best-effort cash branches; public execution traces keep costs from being counted twice.",
      "Reviewed physical-to-USD terms cover ten commodity assets, preserving conservative delivery scope, lot identity, published fees, and settlement gaps. Physical delivery alone remains diagnostic rather than USD Exit credit.",
    ],
    commits: [],
    reconstructed: false,
  },
];
