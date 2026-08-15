import type { ReserveRisk } from "../../types";

export interface ReserveRiskPresentation {
  shortLabel: string;
  longLabel: string;
}

/** Canonical compact and standalone labels for reserve-risk classification tiers. */
export const RESERVE_RISK_PRESENTATION: Readonly<Record<ReserveRisk, ReserveRiskPresentation>> = {
  "very-low": { shortLabel: "Very low", longLabel: "Very Low Risk" },
  low: { shortLabel: "Low", longLabel: "Low Risk" },
  medium: { shortLabel: "Medium", longLabel: "Medium Risk" },
  high: { shortLabel: "High", longLabel: "High Risk" },
  "very-high": { shortLabel: "Very high", longLabel: "Very High Risk" },
};
