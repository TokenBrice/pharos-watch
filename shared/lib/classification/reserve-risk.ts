import type { ReserveRisk } from "../../types";

export interface ReserveRiskPresentation {
  shortLabel: string;
  longLabel: string;
  accentColor: string;
  fillColor: string;
}

/** Canonical labels and chart hues (24% tile fill) for reserve-risk tiers. */
export const RESERVE_RISK_PRESENTATION: Readonly<Record<ReserveRisk, ReserveRiskPresentation>> = {
  "very-low": { shortLabel: "Very low", longLabel: "Very Low Risk", accentColor: "#3bcc87", fillColor: "#3bcc873d" },
  low: { shortLabel: "Low", longLabel: "Low Risk", accentColor: "#14b8a6", fillColor: "#14b8a63d" },
  medium: { shortLabel: "Medium", longLabel: "Medium Risk", accentColor: "#eab308", fillColor: "#eab3083d" },
  high: { shortLabel: "High", longLabel: "High Risk", accentColor: "#f97316", fillColor: "#f973163d" },
  "very-high": { shortLabel: "Very high", longLabel: "Very High Risk", accentColor: "#ef4444", fillColor: "#ef44443d" },
};
