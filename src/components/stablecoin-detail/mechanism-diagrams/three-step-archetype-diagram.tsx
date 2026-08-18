import type { MechanismArchetype } from "@shared/types";

import {
  ThreeStepMechanismDiagram,
  type MechanismStepOverride,
  type MechanismStepText,
  type ThreeStepMechanismDiagramProps,
} from "./three-step-diagram";

export type ThreeStepArchetype = Exclude<MechanismArchetype, "synthetic-delta-neutral">;

export function isThreeStepArchetype(archetype: MechanismArchetype): archetype is ThreeStepArchetype {
  return archetype !== "synthetic-delta-neutral";
}

type ThreeStepConfig = {
  accentColor: string;
  stressFootnote: string;
  ariaLabel: (symbol: string) => string;
  description: (symbol: string) => string;
  defaultSteps: (symbol: string) => readonly [MechanismStepText, MechanismStepText, MechanismStepText];
  returnArrow?: ThreeStepMechanismDiagramProps["returnArrow"];
  stepTone?: ThreeStepMechanismDiagramProps["stepTone"];
  dashed?: boolean;
};

export const THREE_STEP_ARCHETYPE_CONFIG: Record<ThreeStepArchetype, ThreeStepConfig> = {
  "fiat-cash": {
    accentColor: "var(--mechanism-fiat-cash)",
    stressFootnote: "stress: banking-rail freeze (USDC, Mar 2023)",
    ariaLabel: (symbol) => `${symbol} mechanism: user dollars in, custodied 1:1, redeemable on demand`,
    description: (symbol) =>
      `Users send USD via wire or ACH to the issuer; the issuer custodies the dollars in cash, repos, and short-term Treasuries; the issuer mints ${symbol} 1:1 and lets holders redeem at any time.`,
    defaultSteps: (symbol) => [
      { label: "User USD", subtitle: "wire / ACH" },
      { label: "Issuer reserves", subtitle: "custodied 1:1" },
      { label: `${symbol} minted`, subtitle: "redeem any time" },
    ],
    returnArrow: {
      fromX: 500,
      toX: 275,
      topY: 90,
      peakY: 140,
      label: "redeem",
      strokeWidth: 1.2,
    },
  },
  tbill: {
    accentColor: "var(--mechanism-tbill)",
    stressFootnote: "stress: instant-redemption cap / stablecoin-rail constraint",
    ariaLabel: (symbol) =>
      `Investor cash funds a short-duration Treasury portfolio; ${symbol} units accrue NAV daily.`,
    description: (symbol) =>
      `Investors subscribe cash into a regulated fund; the fund deploys into short-duration T-Bills and repurchase agreements; ${symbol} units represent fund shares whose NAV accrues daily from the underlying yield.`,
    defaultSteps: (symbol) => [
      { label: "Investor cash", subtitle: "subscribed via fund" },
      { label: "T-Bills + Repos", subtitle: "short-duration RWA" },
      { label: `${symbol} units`, subtitle: "NAV accrues daily" },
    ],
  },
  cdp: {
    accentColor: "var(--mechanism-cdp)",
    stressFootnote: "stress: collateral cascade (DAI, Mar 2020)",
    ariaLabel: (symbol) =>
      `Users overcollateralize crypto in a vault to mint ${symbol} as debt; the position is liquidated if collateral falls below the safety ratio.`,
    description: (symbol) =>
      `Users deposit crypto collateral worth more than the debt they want to issue; a vault or peg-stability module mints ${symbol} as debt against the collateral; the position is liquidated if the collateral value falls below the configured safety ratio.`,
    defaultSteps: (symbol) => [
      { label: "Crypto collateral", subtitle: "overcollateralized" },
      { label: "Vault / PSM", subtitle: "mint debt vs collateral" },
      { label: `${symbol} minted`, subtitle: "liquidates below ratio" },
    ],
    returnArrow: {
      fromX: 500,
      toX: 75,
      topY: 90,
      peakY: 140,
      label: "or liquidated",
      tone: "danger",
      dashed: true,
    },
  },
  algorithmic: {
    accentColor: "var(--mechanism-algorithmic)",
    stressFootnote: "stress: reflexive collapse (UST, May 2022)",
    ariaLabel: (symbol) =>
      `An algorithmic mint/burn module trades a governance token for ${symbol} to defend the peg; the design has no 1:1 reserve backing.`,
    description: (symbol) =>
      `Users burn a governance token to algorithmically mint ${symbol}; an autonomous mint/burn module defends the peg through arbitrage incentives; the system has no 1:1 reserve backing, so confidence in the governance token is critical.`,
    defaultSteps: (symbol) => [
      { label: "Burn governance token", subtitle: "algorithmic mint" },
      { label: "Mint/burn AMO", subtitle: "defends peg via arbitrage" },
      { label: `${symbol} minted`, subtitle: "no 1:1 backing" },
    ],
    stepTone: "danger",
    dashed: true,
    returnArrow: {
      fromX: 500,
      toX: 75,
      topY: 90,
      peakY: 140,
      label: "reflexive collapse",
      tone: "danger",
      dashed: true,
      strokeWidth: 1.2,
    },
  },
  "rwa-credit-fund": {
    accentColor: "var(--mechanism-rwa-credit-fund)",
    stressFootnote: "stress: NAV markdown / quarterly gate",
    ariaLabel: (symbol) =>
      `Accredited investor cash funds a private-credit or CLO portfolio; ${symbol} fund-share NAV reflects credit losses with quarterly redemption gates.`,
    description: (symbol) =>
      `Accredited investors subscribe cash into a regulated credit fund; the fund deploys into private credit, CLOs, or structured debt with real default risk and limited liquidity; ${symbol} represents a fund share whose NAV reflects credit performance, with redemptions typically allowed only at quarterly windows.`,
    defaultSteps: (symbol) => [
      { label: "Investor cash", subtitle: "subscribed via fund (KYC)" },
      { label: "Private credit / CLO", subtitle: "credit risk, illiquid" },
      { label: `${symbol} fund-share`, subtitle: "NAV reflects credit losses" },
    ],
    returnArrow: {
      fromX: 500,
      toX: 75,
      topY: 90,
      peakY: 140,
      label: "quarterly redemption",
      strokeWidth: 1.2,
      dashed: true,
    },
  },
  "commodity-claim": {
    accentColor: "var(--mechanism-commodity-claim)",
    stressFootnote: "stress: vault or title failure; whole-bar redemption minimums",
    ariaLabel: (symbol) =>
      `Buyer funds allocate specific vaulted metal; ${symbol} is a title claim on numbered bars, redeemable for physical delivery in whole-bar lots.`,
    description: (symbol) =>
      `Buyers send funds to the issuer, which purchases metal and allocates specific numbered bars in a named vault; ${symbol} is minted as a title claim on that allocated metal, and holders can redeem for physical delivery subject to whole-bar minimums, fees, and eligibility.`,
    defaultSteps: (symbol) => [
      { label: "Buyer funds", subtitle: "metal purchased" },
      { label: "Allocated vault", subtitle: "numbered bars, segregated" },
      { label: `${symbol} minted`, subtitle: "title to specific metal" },
    ],
    returnArrow: {
      fromX: 500,
      toX: 275,
      topY: 90,
      peakY: 140,
      label: "physical delivery",
      strokeWidth: 1.2,
      dashed: true,
    },
  },
};

/**
 * The `tbill` archetype covers two structurally different instruments:
 * NAV-accreting fund shares (OUSG, USDY, USYC — 22 tracked coins) and
 * $1-pegged tokens that merely hold a T-Bill reserve and redeem at par
 * (BUIDL, USDtb, USD0, Gate USD — 25 tracked coins, `flags.navToken: false`).
 * Applying "NAV accrues daily" to the second family asserts a yield mechanic
 * they do not have, and the missing redeem loop compounds it by drawing them
 * as one-way instruments (owner feedback 2026-08-18).
 *
 * So the archetype carries a second config and callers that hold a coin pass
 * its `flags.navToken`. Callers without a coin — the `/learn` explainer and the
 * comparison matrix, which describe the fund-share family — pass nothing and
 * keep the NAV-accreting default.
 */
const TBILL_PAR_REDEMPTION_CONFIG: ThreeStepConfig = {
  accentColor: "var(--mechanism-tbill)",
  stressFootnote: "stress: redemption gate / reserve-rail constraint",
  ariaLabel: (symbol) =>
    `Subscriber cash funds a short-duration Treasury reserve; ${symbol} is minted at par and redeemed 1:1.`,
  description: (symbol) =>
    `Subscribers send cash or an accepted stablecoin to the issuer; the reserve is held in short-duration T-Bills, repos, and cash; ${symbol} is minted 1:1 against that reserve and redeems at par — the yield reaches holders through unit accrual or a separate staked wrapper, not through the token's unit price.`,
  defaultSteps: (symbol) => [
    { label: "Subscriber cash", subtitle: "cash / accepted stablecoin" },
    { label: "T-Bills + Repos", subtitle: "short-duration RWA" },
    { label: `${symbol} minted`, subtitle: "redeem 1:1" },
  ],
  returnArrow: {
    fromX: 500,
    toX: 275,
    topY: 90,
    peakY: 140,
    label: "redeem",
    strokeWidth: 1.2,
  },
};

/**
 * Resolves the archetype's diagram copy for one coin. `navToken` is the coin's
 * `flags.navToken`; `undefined`/`null` means "no coin in hand" and keeps the
 * archetype default.
 */
export function resolveThreeStepConfig(
  archetype: ThreeStepArchetype,
  navToken?: boolean | null,
): ThreeStepConfig {
  if (archetype === "tbill" && navToken === false) return TBILL_PAR_REDEMPTION_CONFIG;
  return THREE_STEP_ARCHETYPE_CONFIG[archetype];
}

export interface ThreeStepArchetypeDiagramProps {
  archetype: ThreeStepArchetype;
  symbol: string;
  steps?: ReadonlyArray<MechanismStepOverride>;
  stressFootnote?: string;
  /** Coin's `flags.navToken`; omit where no coin is in hand (see {@link resolveThreeStepConfig}). */
  navToken?: boolean | null;
}

export function ThreeStepArchetypeDiagram({
  archetype,
  symbol,
  steps: overrideSteps,
  stressFootnote,
  navToken,
}: ThreeStepArchetypeDiagramProps) {
  const config = resolveThreeStepConfig(archetype, navToken);
  return (
    <ThreeStepMechanismDiagram
      ariaLabel={config.ariaLabel(symbol)}
      description={config.description(symbol)}
      accentColor={config.accentColor}
      defaultSteps={config.defaultSteps(symbol)}
      overrideSteps={overrideSteps}
      stressFootnote={stressFootnote ?? config.stressFootnote}
      returnArrow={config.returnArrow}
      stepTone={config.stepTone}
      dashed={config.dashed}
    />
  );
}
