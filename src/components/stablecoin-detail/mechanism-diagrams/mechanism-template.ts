import type { MechanismArchetype, OracleRiskRole, VariantKind } from "@shared/types";
import type { MechanismBackingView } from "@/lib/mechanism-backing";

import { isThreeStepArchetype, resolveThreeStepConfig, type ThreeStepConfig } from "./three-step-archetype-diagram";
import type { CoinOverride, MechanismTemplateFacts } from "./types";

/**
 * Template selection for a coin's mechanism flow: which archetype copy, which
 * coin-level variant inside it (see {@link MechanismTemplateFacts}), and which
 * coin overrides apply. The Mechanism module renders the result as a DOM flow;
 * the generic SVG diagrams read the same copy without facts.
 */

export interface MechanismFlowStep {
  label: string;
  subtitle?: string;
}

export type MechanismFlowSteps = readonly [MechanismFlowStep, MechanismFlowStep, MechanismFlowStep];

/** A return or carry path between two steps (zero-based indexes). */
export interface MechanismFlowLoop {
  from: number;
  to: number;
  label: string;
  /** Failure path (liquidation, reflexive collapse) rather than an ordinary exit. */
  danger: boolean;
  /** Gated or conditional path. */
  dashed: boolean;
}

export interface MechanismFlowTemplate {
  accentColor: string;
  ariaLabel: string;
  description: string;
  steps: MechanismFlowSteps;
  loop: MechanismFlowLoop | null;
  /**
   * Structural stress path, or the coin's own dated incident from its
   * override; never another coin's incident. `null` when there is none to name.
   */
  stressFootnote: string | null;
  /** No 1:1 backing (algorithmic): steps draw dashed and tinted. */
  fragile: boolean;
}

interface FlowCopy {
  accentColor: string;
  stressFootnote: string;
  ariaLabel: (symbol: string) => string;
  description: (symbol: string) => string;
  defaultSteps: (symbol: string) => MechanismFlowSteps;
  loop: MechanismFlowLoop | null;
  fragile: boolean;
}

export type SyntheticStrategy = NonNullable<CoinOverride["syntheticStrategy"]>;

/**
 * Hedged-synthetic copy per implementation. The generic SVG reads the
 * `perp-short` entry; ftUSD-style lending carry opts into `borrow-stake`
 * through its coin override.
 */
export const SYNTHETIC_DELTA_NEUTRAL_COPY: Record<SyntheticStrategy, FlowCopy> = {
  "perp-short": {
    accentColor: "var(--mechanism-synthetic-delta-neutral)",
    stressFootnote: "stress: funding-rate inversion",
    ariaLabel: (symbol) =>
      `Crypto deposited as spot collateral is hedged with equal short perp positions; the funding rate paid by perp longs becomes the yield on ${symbol}.`,
    description: (symbol) =>
      `Users deposit crypto as spot collateral; the protocol opens an equal-size short perpetual futures position to neutralize price exposure; the funding rate paid by perp longs flows to ${symbol} holders as yield.`,
    defaultSteps: (symbol) => [
      { label: "Crypto deposit", subtitle: "spot collateral" },
      { label: "Long spot + short perp", subtitle: "delta-neutral hedge" },
      { label: `${symbol} minted`, subtitle: "funding-rate yield" },
    ],
    loop: { from: 1, to: 2, label: "funding", danger: false, dashed: false },
    fragile: false,
  },
  "borrow-stake": {
    accentColor: "var(--mechanism-synthetic-delta-neutral)",
    stressFootnote: "stress: borrow cost or liquidation shock",
    ariaLabel: (symbol) =>
      `Stablecoin collateral is lent while native assets are borrowed and staked as matched exposure; ${symbol} remains the non-yielding base token and carry is routed to its staked wrapper and the protocol.`,
    description: (symbol) =>
      `Stablecoin deposits are supplied to lending markets; the protocol borrows native assets and stakes the borrowed exposure; strategy carry is routed separately from the non-yielding ${symbol} base token.`,
    defaultSteps: (symbol) => [
      { label: "Stablecoin deposit", subtitle: "lending collateral" },
      { label: "Borrow native + stake", subtitle: "matched carry exposure" },
      { label: `${symbol} base token`, subtitle: "carry routed separately" },
    ],
    loop: { from: 1, to: 2, label: "carry", danger: false, dashed: false },
    fragile: false,
  },
};

/** Step-box centres on the 600-wide SVG canvas the three-step configs target. */
const SVG_STEP_CENTER_X = [75, 275, 500] as const;

function nearestStep(x: number): number {
  let best = 0;
  for (let index = 1; index < SVG_STEP_CENTER_X.length; index += 1) {
    if (Math.abs(SVG_STEP_CENTER_X[index] - x) < Math.abs(SVG_STEP_CENTER_X[best] - x)) best = index;
  }
  return best;
}

function threeStepFlowCopy(config: ThreeStepConfig): FlowCopy {
  const arrow = config.returnArrow;
  return {
    accentColor: config.accentColor,
    stressFootnote: config.stressFootnote,
    ariaLabel: config.ariaLabel,
    description: config.description,
    defaultSteps: config.defaultSteps,
    loop: arrow
      ? {
          from: nearestStep(arrow.fromX),
          to: nearestStep(arrow.toX),
          label: arrow.label,
          danger: arrow.tone === "danger",
          dashed: arrow.dashed === true,
        }
      : null,
    fragile: config.dashed === true,
  };
}

function mergeStep(step: MechanismFlowStep, override: CoinOverride["steps"], index: number): MechanismFlowStep {
  const replacement = override?.[index];
  const subtitle = replacement?.subtitle ?? step.subtitle;
  return { label: replacement?.label ?? step.label, ...(subtitle ? { subtitle } : {}) };
}

/**
 * Resolves the flow a coin page draws. `facts` is required: a coin is in hand,
 * so family-level claims its data cannot support are withheld (a `cdp` coin
 * whose review rules out liquidation gets the reserve copy; a credit fund
 * states no redemption cadence).
 */
export function resolveMechanismFlowTemplate(
  archetype: MechanismArchetype,
  symbol: string,
  facts: MechanismTemplateFacts,
  override?: CoinOverride,
): MechanismFlowTemplate {
  const copy = isThreeStepArchetype(archetype)
    ? threeStepFlowCopy(resolveThreeStepConfig(archetype, facts))
    : SYNTHETIC_DELTA_NEUTRAL_COPY[override?.syntheticStrategy ?? "perp-short"];
  const [first, second, third] = copy.defaultSteps(symbol);
  const stressFootnote = override?.stressFootnote ?? copy.stressFootnote;
  return {
    accentColor: copy.accentColor,
    ariaLabel: copy.ariaLabel(symbol),
    description: copy.description(symbol),
    steps: [mergeStep(first, override?.steps, 0), mergeStep(second, override?.steps, 1), mergeStep(third, override?.steps, 2)],
    loop: copy.loop,
    stressFootnote: stressFootnote || null,
    fragile: copy.fragile,
  };
}

export interface WrapperLayer {
  symbol: string;
  parentSymbol: string;
  /** Short wrapper kind, sentence case: "Savings vault". */
  kind: string;
  description: string;
  stressFootnote: string;
  ariaLabel: string;
}

const VARIANT_KIND_LABEL: Record<VariantKind, string> = {
  "pure-wrapper": "1:1 wrapper",
  "savings-passthrough": "Savings vault",
  "strategy-vault": "Strategy vault",
  "risk-absorption": "Risk-absorption vault",
  "bond-maturity": "Bond-maturity vault",
};

const VARIANT_DESCRIPTION: Record<VariantKind, string> = {
  "pure-wrapper": "wraps and unwraps the parent claim 1:1",
  "savings-passthrough": "routes savings yield to holders",
  "strategy-vault": "routes strategy yield to holders",
  "risk-absorption": "absorbs first-loss for senior holders",
  "bond-maturity": "fixed-maturity bond exposure",
};

/**
 * Wrapper stress names only what the variant kind itself implies; withdrawal
 * mechanics (cooldowns, queues) differ per vault and belong to the coin's
 * Redemption route.
 */
const VARIANT_STRESS_FOOTNOTE: Record<VariantKind, string> = {
  "pure-wrapper": "stress: parent stress + wrapper contract",
  "savings-passthrough": "stress: parent stress + vault withdrawal terms",
  "strategy-vault": "stress: parent stress + strategy unwind",
  "risk-absorption": "stress: parent stress + first-loss absorption",
  "bond-maturity": "stress: parent stress + maturity mismatch",
};

export function resolveWrapperLayer(
  symbol: string,
  parentSymbol: string,
  variantKind?: VariantKind | null,
): WrapperLayer {
  const kind = variantKind ? VARIANT_KIND_LABEL[variantKind] : "Wrapper vault";
  const description = variantKind ? VARIANT_DESCRIPTION[variantKind] : "routes yield to holders";
  return {
    symbol,
    parentSymbol,
    kind,
    description,
    stressFootnote: variantKind ? VARIANT_STRESS_FOOTNOTE[variantKind] : "stress: parent stress + wrapper terms",
    ariaLabel: `${symbol} is a ${kind.toLowerCase()} wrapping ${parentSymbol}; it ${description}.`,
  };
}

/**
 * `false` only when two independent reviewed facts agree that the coin has
 * no liquidation engine: the mechanism review rules the liquidation-mechanics
 * component not applicable, and the oracle review finds no feed consuming
 * borrower collateral (`coin-price-feed`). The review alone is not enough —
 * GHO, Hollar and Yamato carry the same ruling for "no dedicated liquidation
 * pool" while external liquidators still clear positions. Anything else is
 * `null`: unknown, so the archetype copy stands.
 */
export function deriveLiquidationEngine(
  backing: Pick<MechanismBackingView, "notes"> | null | undefined,
  oracleRole: OracleRiskRole | null | undefined,
): false | null {
  const ruledOut =
    backing?.notes.some((note) => note.key === "component:liquidationMechanics" && note.state === "not-applicable") ??
    false;
  return ruledOut && oracleRole === "coin-price-feed" ? false : null;
}
