/**
 * "What to watch" prose templates.
 *
 * 24 cells = 8 live `LowestSubDimensionKey`s × 3 profiles. Each cell carries a
 * minimal hand-written template (≤80 chars after substitution per design
 * §2.7); contextKey-refined templates are deferred to Phase 2.
 *
 * The three axes retired at `selector-v2.0` — `dependencyRisk`,
 * `collateralQuality`, `custodyModel` — keep their slot in the
 * `LowestSubDimensionKey` vocabulary so stored snapshots that recorded them
 * still render, but `lookupNormalizedSubDimension` returns `null` for all
 * three, so no live run can select them. Their template cells are gone;
 * `getTemplate` returns `null` for a retired key.
 *
 * Editorial owner: tokenbrice. The strings here are first-draft templates
 * meant to clear the selector editorial policy (design §4.5). Substitute `{dimensionLabel}`
 * with the rendered dimension name and `{scoreOrGrade}` with the score.
 *
 * Binding: see `docs/screener-picker-page.md` for the maintained editorial
 * template contract.
 */
import type {
  LowestSubDimension,
  LowestSubDimensionKey,
  MergedRow,
  SelectorLowerRanked,
  SelectorProfile,
} from "./types";
import { selectorComponentProseLabel, selectorExclusionReasonLabel } from "./selector-labels";

export interface WhatToWatchTemplate {
  /** Free-form prose ≤80 chars after substitution. */
  oneLineExplanation: string;
}

/** Axes a live run can actually select; see `lowest-sub-dimension.ts`. */
export type LiveWatchKey = Exclude<
  LowestSubDimensionKey,
  "dependencyRisk" | "collateralQuality" | "custodyModel"
>;

type TemplateMatrix = Readonly<
  Record<SelectorProfile, Readonly<Record<LiveWatchKey, WhatToWatchTemplate>>>
>;

/**
 * 24-cell matrix. Each cell is a non-fallback template.
 *
 * Drafting guardrails:
 *  - No "Pharos recommends", "Top pick", "Safe", "Best", "Trusted by", "Battle-tested". (banned-phrase-allow: drafting-guardrails-self-documentation)
 *  - No "Probably/likely/reliably", "We recommend you …", "Easy/simple/convenient". (banned-phrase-allow: drafting-guardrails-self-documentation)
 *  - No "strongest current reading", "use [coin] for [purpose]", "deprecated rail". (banned-phrase-allow: drafting-guardrails-self-documentation)
 *  - Hedge the framing, not the data: name the dimension and the reading.
 *  - "What to watch" never claims the future will resemble the past.
 */
export const TEMPLATES: TemplateMatrix = {
  treasury: {
    pegStability: {
      oneLineExplanation: "Peg history sits below its peers; review the recent deviations log.",
    },
    liquidity: {
      oneLineExplanation: "DEX depth lags peers; size exits against current order books.",
    },
    resilience: {
      oneLineExplanation: "Structural resilience is the weak axis; chain and custody add risk.",
    },
    decentralization: {
      oneLineExplanation: "Issuer holds privileged controls; the coin is not censorship-resistant.",
    },
    governanceOverride: {
      oneLineExplanation: "Issuer can freeze or dilute supply; review blacklisting policy.",
    },
    activeDepegHistory: {
      oneLineExplanation: "Past deviations exceed the peer median; track the depeg event log.",
    },
    yieldVariance: {
      oneLineExplanation: "Yield variance is not the treasury-frame concern; ignore unless rotating.",
    },
    sourceRisk: {
      oneLineExplanation: "Source-risk attaches to yield rails; treasury holds the unwrapped coin.",
    },
  },
  yield: {
    pegStability: {
      oneLineExplanation: "Peg history is the soft spot; yield denominated in a wobbly peg shrinks.",
    },
    liquidity: {
      oneLineExplanation: "Exit liquidity is the weak axis; size the position to DEX depth.",
    },
    resilience: {
      oneLineExplanation: "Underlying resilience lags peers; the yield rail inherits that risk.",
    },
    decentralization: {
      oneLineExplanation: "Issuer holds privileged controls; the rail is not censorship-resistant.",
    },
    governanceOverride: {
      oneLineExplanation: "Issuer can freeze the yield-bearing wrapper; review redemption rights.",
    },
    activeDepegHistory: {
      oneLineExplanation: "Past depegs exceed peer median; the yield can be eaten by drift.",
    },
    yieldVariance: {
      oneLineExplanation: "30-day APY variance is high; the realized return may diverge from the headline.",
    },
    sourceRisk: {
      oneLineExplanation: "The yield venue carries source-risk; review the route before sizing.",
    },
  },
  trading: {
    pegStability: {
      oneLineExplanation: "Peg history shows drift; expect slippage at the bid-ask on stress days.",
    },
    liquidity: {
      oneLineExplanation: "DEX depth is the soft spot; size each leg against current order books.",
    },
    resilience: {
      oneLineExplanation: "Structural resilience is the weak axis; check chain tier before routing.",
    },
    decentralization: {
      oneLineExplanation: "Issuer holds privileged controls; track freeze and dilute history.",
    },
    governanceOverride: {
      oneLineExplanation: "Issuer can freeze tokens mid-trade; check the blacklisting policy.",
    },
    activeDepegHistory: {
      oneLineExplanation: "Past deviations exceed peer median; widen quotes during depeg windows.",
    },
    yieldVariance: {
      oneLineExplanation: "Yield variance is not the trading-frame concern; track peg drift instead.",
    },
    sourceRisk: {
      oneLineExplanation: "Source-risk attaches to yield rails; trading holds the unwrapped coin.",
    },
  },
};

/**
 * Returns the template for the given coordinates, or `null` when the cell
 * is uncovered (the engine raises `template-coverage-gap` in that case).
 *
 * `contextKeys` is accepted for API symmetry; Phase 1 ships a single template
 * per `(key, profile)` cell. Context-refined templates land in Phase 2.
 */
export function getTemplate(
  key: LowestSubDimensionKey,
  profile: SelectorProfile,
): WhatToWatchTemplate | null {
  return (TEMPLATES[profile] as Partial<Record<LowestSubDimensionKey, WhatToWatchTemplate>>)[key] ?? null;
}

function roundedBps(value: number): number {
  return Math.round(Math.abs(value));
}

function hasFreezeControls(row: MergedRow): boolean {
  return (
    row.canBeBlacklisted === true ||
    row.canBeBlacklisted === "inherited" ||
    row.canBeBlacklisted === "possible"
  );
}

function sourceRiskWatchText(row: MergedRow): string | null {
  if (
    row.venueRiskTier === "high" ||
    (row.sourceRiskScore != null && row.sourceRiskScore >= 60)
  ) {
    return "Yield route carries elevated source risk; check venue depth before sizing.";
  }
  return null;
}

function thinTvlWatchText(row: MergedRow): string | null {
  if (
    row.warningSignals.includes("thin-tvl") ||
    (row.effectiveTvlUsd != null && row.effectiveTvlUsd < 25_000_000)
  ) {
    return "Yield venue depth is thin; size the route against source TVL.";
  }
  return null;
}

export function renderWatchText(
  lowest: LowestSubDimension,
  profile: SelectorProfile,
  row: MergedRow,
): string | undefined {
  if (lowest.key === "pegStability" && row.currentDeviationBps != null) {
    const deviation = roundedBps(row.currentDeviationBps);
    if (deviation >= 25) {
      return `Current peg is ${deviation} bps off; compare against the tolerance setting.`;
    }
  }

  if (lowest.key === "activeDepegHistory" && row.depegEventCount > 0) {
    return `Depeg log shows ${row.depegEventCount} events; keep PegScore and peg history in view.`;
  }

  if (lowest.key === "governanceOverride" && hasFreezeControls(row)) {
    return "Freeze or supply controls exist; review issuer permissions before routing.";
  }

  if (lowest.key === "sourceRisk") {
    const text = sourceRiskWatchText(row);
    if (text != null) return text;
  }

  if (lowest.key === "liquidity") {
    const text = thinTvlWatchText(row);
    if (text != null) return text;
  }

  if (
    lowest.key === "decentralization" &&
    (row.governance === "centralized" || row.governance === "centralized-dependent")
  ) {
    return "Governance is centralized; admin decisions can change transfer rules.";
  }

  if (row.isRecentListing) {
    return "Recent listing; compare fresh readings before sizing.";
  }

  if (row.currentDeviationBps != null && roundedBps(row.currentDeviationBps) >= 50) {
    return `Current peg is ${roundedBps(row.currentDeviationBps)} bps off; compare against the tolerance setting.`;
  }

  if (row.depegEventCount >= 2) {
    return `Depeg log shows ${row.depegEventCount} events; keep PegScore and peg history in view.`;
  }

  if (hasFreezeControls(row)) {
    return "Freeze or supply controls exist; review issuer permissions before routing.";
  }

  const sourceRiskText = sourceRiskWatchText(row);
  if (sourceRiskText != null) return sourceRiskText;

  const thinTvlText = thinTvlWatchText(row);
  if (thinTvlText != null) return thinTvlText;

  return getTemplate(lowest.key, profile)?.oneLineExplanation;
}

const LOWER_REASON_LABELS: Readonly<Record<string, string>> = {
  "active-depeg": "the current peg-deviation gate",
  "peg-score-floor": "the PegScore floor",
  "safety-resilience-floor": "the resilience floor",
  "safety-dependency-risk-floor": "the dependency-risk floor",
  "dews-ceiling": "the stress-signal ceiling",
  "bluechip-d-or-f": "the third-party bluechip floor",
  "custody-regulated-only-violation": "the regulated-custody rail",
  "custody-onchain-only-violation": "the on-chain custody rail",
  "high-venue-on-c-tier": "the venue-risk gate",
  "yield-warning-unstable": "the APY-stability warning gate",
  "yield-warning-thin-tvl": "the source-depth warning gate",
  "liquidity-floor": "the liquidity floor",
  "liquidity-diversification-floor": "the venue-diversification floor",
  "effective-exit-floor": "the effective-exit floor",
  "supply-tvl-floor-1h": "the fast-exit depth floor",
};

export function labelForSelectorReason(reasonKey: string): string {
  if (reasonKey.startsWith("weak-")) {
    const component = reasonKey.slice("weak-".length);
    return selectorComponentProseLabel(component) ?? "a profile-emphasized metric";
  }
  return LOWER_REASON_LABELS[reasonKey] ?? selectorExclusionReasonLabel(reasonKey) ?? "a profile-specific gate";
}

export function getLowerRankedText(
  entry: Pick<SelectorLowerRanked, "symbol" | "reasonKey" | "failedComponent">,
): Pick<SelectorLowerRanked, "verdictText" | "teachingText"> {
  const label = entry.failedComponent
    ? selectorComponentProseLabel(entry.failedComponent) ?? "the emphasized metric"
    : labelForSelectorReason(entry.reasonKey);
  return {
    verdictText: `${entry.symbol}: profile mismatch`,
    teachingText: `This row missed ${label}; compare the live reading before relaxing that constraint.`,
  };
}
