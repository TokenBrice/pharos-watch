/**
 * "What to watch" prose templates.
 *
 * 33 cells = 11 `LowestSubDimensionKey` × 3 profiles. Each cell carries a
 * minimal hand-written template (≤80 chars after substitution per design
 * §2.7); contextKey-refined templates are deferred to Phase 2.
 *
 * Editorial owner: tokenbrice. The strings here are first-draft templates
 * meant to clear the banned-phrase lint (design §4.5). Substitute `{dimensionLabel}`
 * with the rendered dimension name and `{scoreOrGrade}` with the score.
 *
 * Binding: `agents/selector-implementation-plan.md` §2.5 + §10 (Milestone 10).
 */
import type { LowestSubDimensionKey, SelectorProfile } from "./types";

export interface WhatToWatchTemplate {
  /** Free-form prose ≤80 chars after substitution. */
  oneLineExplanation: string;
}

type TemplateMatrix = Readonly<
  Record<SelectorProfile, Readonly<Record<LowestSubDimensionKey, WhatToWatchTemplate>>>
>;

/**
 * 33-cell matrix. Each cell is a non-fallback template.
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
    dependencyRisk: {
      oneLineExplanation: "Upstream dependencies inflate failure surface; check the dependency map.",
    },
    collateralQuality: {
      oneLineExplanation: "Collateral mix sits below mainstream-cash standards for treasury parking.",
    },
    custodyModel: {
      oneLineExplanation: "Custody model relies on a single entity; counterparty risk is concentrated.",
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
    dependencyRisk: {
      oneLineExplanation: "Upstream dependencies stack; one break interrupts the yield path.",
    },
    collateralQuality: {
      oneLineExplanation: "Collateral mix is the weak axis; review what backs the yield-bearing token.",
    },
    custodyModel: {
      oneLineExplanation: "Custody model concentrates counterparty exposure on a single entity.",
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
    dependencyRisk: {
      oneLineExplanation: "Upstream dependencies inflate the failure surface; review the dependency map.",
    },
    collateralQuality: {
      oneLineExplanation: "Collateral mix sits below mainstream-cash standards for fast turnover.",
    },
    custodyModel: {
      oneLineExplanation: "Custody model concentrates counterparty exposure; settlement risk is real.",
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
  return TEMPLATES[profile][key] ?? null;
}
