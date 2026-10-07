import type { MechanismArchetype } from "@shared/types";

import {
  ThreeStepMechanismDiagram,
  type MechanismStepText,
  type ThreeStepMechanismDiagramProps,
} from "./three-step-diagram";
import type { MechanismTemplateFacts } from "./types";

export type ThreeStepArchetype = Exclude<MechanismArchetype, "synthetic-delta-neutral">;

export function isThreeStepArchetype(archetype: MechanismArchetype): archetype is ThreeStepArchetype {
  return archetype !== "synthetic-delta-neutral";
}

export type ThreeStepConfig = {
  accentColor: string;
  /**
   * The family's stress path, phrased so it holds for every member. It names
   * no coin: coin pages draw it as is, and a coin's own dated incident comes
   * from its coin override.
   */
  stressFootnote: string;
  /**
   * The family's canonical dated incident ("USDC, Mar 2023"), appended only on
   * the generic archetype render (`/learn`, OG images). Never drawn on a coin
   * page, where it would name another coin.
   */
  stressPrecedent?: string;
  ariaLabel: (symbol: string) => string;
  description: (symbol: string) => string;
  defaultSteps: (symbol: string) => readonly [MechanismStepText, MechanismStepText, MechanismStepText];
  returnArrow?: ThreeStepMechanismDiagramProps["returnArrow"];
  stepTone?: ThreeStepMechanismDiagramProps["stepTone"];
  dashed?: boolean;
};

const THREE_STEP_ARCHETYPE_CONFIG: Record<ThreeStepArchetype, ThreeStepConfig> = {
  "fiat-cash": {
    accentColor: "var(--mechanism-fiat-cash)",
    stressFootnote: "stress: banking-rail freeze",
    stressPrecedent: "USDC, Mar 2023",
    ariaLabel: (symbol) =>
      `${symbol} mechanism: customer funds in by bank transfer, custodied 1:1, redeemable through the issuer by eligible holders`,
    description: (symbol) =>
      `Onboarded customers send fiat to the issuer by bank transfer; the issuer custodies the funds in cash and short-term instruments such as repos and government bills, and mints ${symbol} 1:1; eligible holders redeem through the issuer, with proceeds typically settling back over banking rails.`,
    defaultSteps: (symbol) => [
      { label: "Customer funds", subtitle: "bank transfer (KYC)" },
      { label: "Issuer reserves", subtitle: "custodied 1:1" },
      { label: `${symbol} minted`, subtitle: "eligible holders redeem" },
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
    stressFootnote: "stress: collateral cascade",
    stressPrecedent: "DAI, Mar 2020",
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
    stressFootnote: "stress: reflexive collapse",
    stressPrecedent: "UST, May 2022",
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
  "ucits-trs-fund": {
    accentColor: "var(--mechanism-tbill)",
    stressFootnote: "stress: incomplete hedge / counterparty collateral loss / fund gate",
    ariaLabel: (symbol) =>
      `${symbol} mechanism: investors hold proportional fund shares backed by physical securities and total-return swaps, redeemable at NAV under fund terms.`,
    description: (symbol) =>
      `Eligible investors subscribe to an exact fund share class; physical securities, signed total-return swaps and any unswapped sleeves determine its economic book; ${symbol} records a proportional fund interest, with NAV reconciliation, collateral and default recovery evaluated separately.`,
    defaultSteps: (symbol) => [
      { label: "Fund subscription", subtitle: "exact share class (KYC)" },
      { label: "Securities + TRS", subtitle: "signed derivative exposure" },
      { label: `${symbol} fund-share`, subtitle: "proportional NAV claim" },
    ],
  },
  "shared-reserve": {
    accentColor: "var(--mechanism-cdp)",
    stressFootnote: "stress: shared liability deficit / encumbrance / exchange liquidity gate",
    ariaLabel: (symbol) =>
      `${symbol} mechanism: a live protocol exchange issues a currency liability backed alongside other currencies by one shared reserve.`,
    description: (symbol) =>
      `An exact live exchange provider issues or exchanges ${symbol}; a common reserve supports several currency liabilities; the operational token claim does not prove exclusive reserve allocation, complete liability coverage or insolvency priority.`,
    defaultSteps: (symbol) => [
      { label: "Protocol exchange", subtitle: "exact live pool / provider" },
      { label: "Shared reserve", subtitle: "several currency liabilities" },
      { label: `${symbol} liability`, subtitle: "operational exchange claim" },
    ],
  },
  "protocol-position": {
    accentColor: "var(--mechanism-cdp)",
    stressFootnote: "stress: position / withdrawal failure / unreconciled residual liabilities",
    ariaLabel: (symbol) =>
      `${symbol} mechanism: bridge or module issuance creates an operational claim on managed protocol positions, with local withdrawal and recovery risk.`,
    description: (symbol) =>
      `An exact deployed bridge or module issues ${symbol}; managers hold underlying vault or protocol positions; holders withdraw through the operational path, while local custody, liability conservation, encumbrance and default recovery remain distinct from the underlying stablecoin's reserves.`,
    defaultSteps: (symbol) => [
      { label: "Bridge / module", subtitle: "exact deployed issuance" },
      { label: "Managed positions", subtitle: "receipts counted once" },
      { label: `${symbol} liability`, subtitle: "protocol withdrawal claim" },
    ],
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
    `Subscribers send cash or an accepted stablecoin to the issuer; the reserve is held in short-duration T-Bills, repos, and cash; ${symbol} is minted 1:1 against that reserve and eligible holders redeem at par. The yield reaches holders through unit accrual or a separate staked wrapper, not through the token's unit price.`,
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
 * `cdp` coins whose reviewed mechanism has no liquidation engine: Djed-style
 * reserves (ZSD, DJED), 1:1 conversion modules and facilitator mints. They
 * share the archetype's collateral book but none of its liquidation path, so
 * the default copy ("liquidates below ratio", the collateral cascade)
 * would contradict the coin's own Backing evidence. Every line here holds for
 * the whole family that `deriveLiquidationEngine` selects; coin specifics go
 * through coin overrides.
 */
const CDP_RESERVE_CONFIG: ThreeStepConfig = {
  accentColor: "var(--mechanism-cdp)",
  stressFootnote: "stress: reserve shortfall with no liquidation backstop",
  ariaLabel: (symbol) =>
    `${symbol} mechanism: the protocol mints and redeems ${symbol} against collateral it holds in reserve; there are no borrower positions and no liquidation engine.`,
  description: (symbol) =>
    `Collateral is deposited with the protocol, which holds it in reserve and mints or redeems ${symbol} under its own rules; with no borrower positions there is no liquidation engine, so a fall in reserve value is absorbed by the reserve rather than cleared by liquidations.`,
  defaultSteps: (symbol) => [
    { label: "Collateral in", subtitle: "held by the protocol" },
    { label: "Protocol reserve", subtitle: "mint and redeem by rule" },
    { label: `${symbol} minted`, subtitle: "no liquidation engine" },
  ],
};

/**
 * The `rwa-credit-fund` family default describes the archetype ("quarterly
 * redemption gates"), but members range from quarterly fund windows to FIFO
 * queues served as liquidity allows (syrupUSDC) and weekly processing. A coin
 * page therefore states no cadence: redemption follows the issuer's terms,
 * and the coin's own Redemption route carries the specifics.
 */
const RWA_CREDIT_COIN_CONFIG: ThreeStepConfig = {
  accentColor: "var(--mechanism-rwa-credit-fund)",
  stressFootnote: "stress: NAV markdown / redemption gate",
  ariaLabel: (symbol) =>
    `Investor cash funds a credit portfolio; ${symbol} value tracks credit performance, and redemptions follow the issuer's terms.`,
  description: (symbol) =>
    `Investors subscribe or deposit cash; the issuer deploys it into private credit or structured debt with real default risk and limited liquidity; ${symbol} value reflects credit performance, with redemption timing and gates set by the issuer's terms.`,
  defaultSteps: (symbol) => [
    { label: "Investor cash", subtitle: "subscribed or deposited" },
    { label: "Credit portfolio", subtitle: "default and liquidity risk" },
    { label: `${symbol} issued`, subtitle: "value tracks credit losses" },
  ],
  returnArrow: {
    fromX: 500,
    toX: 75,
    topY: 90,
    peakY: 140,
    label: "redeem",
    strokeWidth: 1.2,
    dashed: true,
  },
};

/**
 * Resolves the archetype's diagram copy. `facts` is the coin in hand (see
 * {@link MechanismTemplateFacts}); without it the archetype keeps its family
 * description, as on `/learn`.
 */
export function resolveThreeStepConfig(
  archetype: ThreeStepArchetype,
  facts?: MechanismTemplateFacts,
): ThreeStepConfig {
  if (!facts) return THREE_STEP_ARCHETYPE_CONFIG[archetype];
  if (archetype === "tbill" && facts.navToken === false) return TBILL_PAR_REDEMPTION_CONFIG;
  if (archetype === "cdp" && facts.liquidationEngine === false) return CDP_RESERVE_CONFIG;
  if (archetype === "rwa-credit-fund") return RWA_CREDIT_COIN_CONFIG;
  return THREE_STEP_ARCHETYPE_CONFIG[archetype];
}

export interface ThreeStepArchetypeDiagramProps {
  archetype: ThreeStepArchetype;
  symbol: string;
}

/** Generic archetype diagram (`/learn`, OG images): family copy and its dated precedent, no coin facts. */
export function ThreeStepArchetypeDiagram({ archetype, symbol }: ThreeStepArchetypeDiagramProps) {
  const config = resolveThreeStepConfig(archetype);
  return (
    <ThreeStepMechanismDiagram
      ariaLabel={config.ariaLabel(symbol)}
      description={config.description(symbol)}
      accentColor={config.accentColor}
      defaultSteps={config.defaultSteps(symbol)}
      stressFootnote={config.stressPrecedent ? `${config.stressFootnote} (${config.stressPrecedent})` : config.stressFootnote}
      returnArrow={config.returnArrow}
      stepTone={config.stepTone}
      dashed={config.dashed}
    />
  );
}
