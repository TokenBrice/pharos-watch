import type { MechanismArchetype } from "@shared/types/stablecoin-taxonomy";

export type MechanismMatrixCol =
  | "collateralLocation"
  | "redemptionRight"
  | "yieldSource"
  | "primaryFailureMode"
  | "governanceDep"
  | "oracleDep"
  | "jurisdictionDep";

export type MechanismMatrixRow = Readonly<Record<MechanismMatrixCol, string>>;

export const MECHANISM_MATRIX_COLUMNS: ReadonlyArray<{
  key: MechanismMatrixCol;
  label: string;
  short: string;
}> = [
  { key: "collateralLocation", label: "Collateral location", short: "Collateral" },
  { key: "redemptionRight", label: "Redemption right", short: "Redemption" },
  { key: "yieldSource", label: "Yield source", short: "Yield" },
  { key: "primaryFailureMode", label: "Primary failure mode", short: "Fails by" },
  { key: "governanceDep", label: "Governance dep.", short: "Governance" },
  { key: "oracleDep", label: "Oracle dep.", short: "Oracle" },
  { key: "jurisdictionDep", label: "Jurisdiction dep.", short: "Jurisdiction" },
];

export const MECHANISM_DEPENDENCY_COLUMNS: ReadonlySet<MechanismMatrixCol> = new Set([
  "governanceDep",
  "oracleDep",
  "jurisdictionDep",
]);

export const MECHANISM_DEPENDENCY_DOT: Readonly<Record<string, string>> = {
  Low: "bg-[var(--severity-healthy)]",
  Medium: "bg-[var(--severity-moderate)]",
  High: "bg-[var(--severity-severe)]",
};

/**
 * Semantic CSS custom properties for each archetype's diagram accent and
 * hub distribution segment (defined in `src/styles/tokens/semantic.css`).
 */
export const MECHANISM_ACCENT_VAR: Readonly<Record<MechanismArchetype, string>> = {
  "fiat-cash": "var(--mechanism-fiat-cash)",
  tbill: "var(--mechanism-tbill)",
  cdp: "var(--mechanism-cdp)",
  "synthetic-delta-neutral": "var(--mechanism-synthetic-delta-neutral)",
  algorithmic: "var(--mechanism-algorithmic)",
  "rwa-credit-fund": "var(--mechanism-rwa-credit-fund)",
  "commodity-claim": "var(--mechanism-commodity-claim)",
  "ucits-trs-fund": "var(--mechanism-ucits-trs-fund)",
  "shared-reserve": "var(--mechanism-shared-reserve)",
  "protocol-position": "var(--mechanism-protocol-position)",
};

/**
 * Single source of truth for mechanism comparison attributes shared by the
 * `/learn/mechanisms/` comparison matrix and each `/learn/mechanisms/[archetype]/`
 * Archetype Fact Strip.
 */
export const MECHANISM_MATRIX: Readonly<Record<MechanismArchetype, MechanismMatrixRow>> = {
  "fiat-cash": {
    collateralLocation: "Off-chain",
    redemptionRight: "1:1",
    yieldSource: "—",
    primaryFailureMode: "Banking-rail freeze",
    governanceDep: "Low",
    oracleDep: "—",
    jurisdictionDep: "High",
  },
  tbill: {
    collateralLocation: "Off-chain",
    redemptionRight: "NAV or par",
    yieldSource: "Treasury yield",
    primaryFailureMode: "Redemption gate",
    governanceDep: "Low",
    oracleDep: "—",
    jurisdictionDep: "High",
  },
  cdp: {
    collateralLocation: "On-chain crypto",
    redemptionRight: "Vault",
    yieldSource: "Liquidations + fees",
    primaryFailureMode: "Liquidation cascade",
    governanceDep: "Medium",
    oracleDep: "High",
    jurisdictionDep: "Low",
  },
  "synthetic-delta-neutral": {
    collateralLocation: "On-chain or custodied",
    redemptionRight: "Strategy unwind",
    yieldSource: "Hedge carry",
    primaryFailureMode: "Carry / unwind stress",
    governanceDep: "Medium",
    oracleDep: "Varies",
    jurisdictionDep: "Medium",
  },
  algorithmic: {
    collateralLocation: "Design-specific: none to protocol collateral",
    redemptionRight: "Burn",
    yieldSource: "—",
    primaryFailureMode: "Reflexive collapse",
    governanceDep: "High",
    oracleDep: "Medium",
    jurisdictionDep: "Low",
  },
  "rwa-credit-fund": {
    collateralLocation: "Off-chain",
    redemptionRight: "Fund gate",
    yieldSource: "Credit yield",
    primaryFailureMode: "NAV markdown",
    governanceDep: "Low",
    oracleDep: "—",
    jurisdictionDep: "High",
  },
  "commodity-claim": {
    collateralLocation: "Vaulted metal",
    redemptionRight: "Physical delivery",
    yieldSource: "—",
    primaryFailureMode: "Vault or title failure",
    governanceDep: "Low",
    oracleDep: "—",
    jurisdictionDep: "High",
  },
  "ucits-trs-fund": {
    collateralLocation: "Physical securities + TRS",
    redemptionRight: "Fund share at NAV; gates",
    yieldSource: "Portfolio / swap return",
    primaryFailureMode: "Hedge / counterparty loss",
    governanceDep: "Medium",
    oracleDep: "Administrator NAV",
    jurisdictionDep: "High",
  },
  "shared-reserve": {
    collateralLocation: "Common reserve pool",
    redemptionRight: "Protocol exchange; liquidity gates",
    yieldSource: "Reserve income, if passed on",
    primaryFailureMode: "Shared liability deficit",
    governanceDep: "High",
    oracleDep: "High",
    jurisdictionDep: "Varies",
  },
  "protocol-position": {
    collateralLocation: "Bridge / vault / module",
    redemptionRight: "Operational position claim; gates",
    yieldSource: "Underlying position, if passed on",
    primaryFailureMode: "Position / withdrawal failure",
    governanceDep: "High",
    oracleDep: "Varies",
    jurisdictionDep: "Varies",
  },
};
