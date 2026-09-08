import type { StablecoinSourceEntry } from "../lib/stablecoin-catalog-sources";

export function makeCoin(id: string, overrides: Record<string, unknown> = {}): StablecoinSourceEntry["coin"] {
  return {
    id,
    name: `${id} Coin`,
    symbol: id.split("-")[0]!.slice(0, 8).toUpperCase(),
    flags: {
      backing: "rwa-backed",
      pegCurrency: "USD",
      governance: "centralized",
      yieldBearing: false,
      rwa: false,
      navToken: false,
    },
    ...overrides,
  } as StablecoinSourceEntry["coin"];
}

export function makeReserves(): Array<Record<string, unknown>> {
  return [
    {
      name: "Cash",
      pct: 100,
      risk: "very-low",
    },
  ];
}

export function makeReserveReview(compositionAsOf: string | null = "2026-07-01"): Record<string, unknown> {
  return {
    reviewedAt: "2026-07-12",
    reviewer: "test",
    confidence: "verified",
    sources: [{ label: "Reserve report", url: "https://example.com/reserves" }],
    rationale: "The fixture reserve composition was reviewed.",
    compositionBasis: "issuer disclosure",
    ...(compositionAsOf === null ? {} : { compositionAsOf }),
    scope: "full-composition",
    knownUnknownExposure: "None identified in the fixture.",
    knownUnknownExposurePct: 0,
  };
}

export function makeCustodyProfile(): Record<string, unknown> {
  return {
    providers: [{ name: "Fixture Bank", role: "bank", sharePct: 100, jurisdiction: "US" }],
    segregation: "segregated",
    bankruptcyRemoteness: "contractual-only",
    rehypothecation: "prohibited",
    reviewedAt: "2026-07-12",
    reviewer: "test",
    confidence: "verified",
    sources: [{ label: "Custody report", url: "https://example.com/custody" }],
    uncertainty: "No material custody allocation is unresolved in the fixture.",
    knownUnknownExposurePct: 0,
  };
}

export function makeMintAuthority(): Record<string, unknown> {
  return {
    mintPath: "unknown",
    authorityPosture: "unknown",
    confidence: "unknown",
    summary: "The fixture mint authority remains unresolved.",
    review: {
      sourceFreeRationale: "Catalog loader fixture without external research.",
      evidence: "The fixture records enough evidence text for strict schema validation.",
      reviewer: "test",
      reviewedAt: "2026-07-09",
    },
  };
}

export function makeGeniusProfile(): Record<string, unknown> {
  return {
    applicability: "unclear",
    authorizationStatus: "unknown",
    issuerPathway: "unknown",
    reviewer: "test",
    reviewedAt: "2026-07-09",
  };
}

export function makeBlacklistabilityReview(): Record<string, unknown> {
  return {
    reviewedStatus: true,
    sourceFreeRationale: "Catalog loader fixture without external research.",
    evidence: "The fixture models a direct blacklistability control surface.",
    reviewer: "test",
    reviewedAt: "2026-07-09",
  };
}

export function makeRiskReview(): Record<string, unknown> {
  return {
    blacklistabilityReview: makeBlacklistabilityReview(),
    oracleRisk: { tier: "opaque-or-unknown", summary: "The fixture oracle design remains unknown." },
    bridgeRouteRisk: {
      tier: "opaque-or-unknown",
      summary: "The fixture bridge route remains unknown.",
      reviewedAt: "2026-07-09",
      reviewer: "test",
      confidence: "unknown",
      sourceFreeRationale: "Catalog loader fixture without external research.",
    },
  };
}
