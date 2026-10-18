import type {
  PublicComponentState,
  PublicHeadlineState,
  PublicStatusComponentId,
  StatusResponse,
} from "../../types";

/** Dashboard badges and runway bars are intentional projections of one status vocabulary. */
export const STATUS_TONE = {
  healthy: {
    label: "Healthy",
    badgeClassName: "border-state-positive bg-state-positive-subtle text-state-positive",
    valueClassName: "text-state-positive",
    barClassName: "bg-state-positive-solid",
  },
  degraded: {
    label: "Degraded",
    badgeClassName: "border-state-warn bg-state-warn-subtle text-state-warn",
    valueClassName: "text-state-warn",
    barClassName: "bg-state-warn-solid",
  },
  stale: {
    label: "Stale",
    badgeClassName: "border-state-danger bg-state-danger-subtle text-state-danger",
    valueClassName: "text-state-danger",
    barClassName: "bg-state-danger-solid",
  },
  unknown: { label: "No probe.", barClassName: "bg-muted-foreground/40" },
} as const satisfies Record<StatusResponse["overallStatus"] | "unknown", {
  label: string;
  barClassName: string;
  badgeClassName?: string;
  valueClassName?: string;
}>;

/** Public status component names and scope (one authority for `/status/` and the site badge). */
export const PUBLIC_COMPONENT_LABEL = {
  "website-api": "Website and API",
  "stablecoin-data": "Stablecoin listings and prices",
  charts: "Historical charts",
  "risk-signals": "Risk signals",
  "safety-scores": "Safety Scores",
  liquidity: "DEX liquidity",
  yield: "Yield",
  "mint-burn": "Mint and burn flows",
  blacklist: "Freeze and blacklist events",
  "data-refresh": "Scheduled data refresh",
} as const satisfies Record<PublicStatusComponentId, string>;

export const PUBLIC_COMPONENT_SCOPE = {
  "website-api": "Pages, the public API and the primary database.",
  "stablecoin-data": "Market caps, rankings, listings, live prices and FX conversion.",
  charts: "Historical supply and price charts.",
  "risk-signals": "Depeg early warnings, stress signals and third-party safety ratings.",
  "safety-scores": "Pharos Safety Scores and their publication.",
  liquidity: "DEX liquidity scores and pool data.",
  yield: "Yield rankings, yield history and their safety ratings.",
  "mint-burn": "Issuance and redemption events.",
  blacklist: "Freeze, blacklist and seizure events.",
  "data-refresh": "The scheduled jobs and upstream sources that keep everything above current.",
} as const satisfies Record<PublicStatusComponentId, string>;

interface StateToneClasses {
  label: string;
  pill: string;
  dot: string;
  bar: string;
  text: string;
}

/**
 * Component state colours. `delayed` is calm blue on purpose: data is late
 * but inside its grace budget, which is information, not alarm.
 */
export const PUBLIC_COMPONENT_STATE_TONE = {
  operational: {
    label: "Operational",
    pill: "border-state-positive bg-state-positive-subtle text-state-positive",
    dot: "bg-state-positive-solid",
    bar: "bg-state-positive-solid",
    text: "text-state-positive",
  },
  delayed: {
    label: "Delayed",
    pill: "border-state-info-solid/25 bg-state-info-subtle text-state-info-bright",
    dot: "bg-state-info-solid",
    bar: "bg-state-info-solid",
    text: "text-state-info-bright",
  },
  degraded: {
    label: "Degraded",
    pill: "border-state-warn bg-state-warn-subtle text-state-warn",
    dot: "bg-state-warn-solid",
    bar: "bg-state-warn-solid",
    text: "text-state-warn",
  },
  outage: {
    label: "Outage",
    pill: "border-state-danger bg-state-danger-subtle text-state-danger",
    dot: "bg-state-danger-solid",
    bar: "bg-state-danger-solid",
    text: "text-state-danger",
  },
} as const satisfies Record<PublicComponentState, StateToneClasses>;

export const PUBLIC_HEADLINE_TONE = {
  operational: { ...PUBLIC_COMPONENT_STATE_TONE.operational, label: "Operational" },
  delayed: { ...PUBLIC_COMPONENT_STATE_TONE.delayed, label: "Delayed" },
  degraded: { ...PUBLIC_COMPONENT_STATE_TONE.degraded, label: "Degraded" },
  "partial-outage": { ...PUBLIC_COMPONENT_STATE_TONE.outage, label: "Partial outage" },
  "major-outage": { ...PUBLIC_COMPONENT_STATE_TONE.outage, label: "Major outage" },
} as const satisfies Record<PublicHeadlineState, StateToneClasses>;

/**
 * Operator verdict: the single answer to "do I need to act?" used by every
 * admin workspace. `act` = public impact past budget or repeated failure;
 * `watch` = known, bounded, or admin-only; `unavailable` = evidence missing.
 */
export type OperatorVerdict = "act" | "watch" | "ok" | "running" | "unavailable";

export const OPERATOR_VERDICT_TONE = {
  act: {
    label: "Act now",
    pill: "border-state-danger bg-state-danger-subtle text-state-danger",
    dot: "bg-state-danger-solid",
    bar: "bg-state-danger-solid",
    text: "text-state-danger",
  },
  watch: {
    label: "Watch",
    pill: "border-state-warn bg-state-warn-subtle text-state-warn",
    dot: "bg-state-warn-solid",
    bar: "bg-state-warn-solid",
    text: "text-state-warn",
  },
  ok: {
    label: "OK",
    pill: "border-border/60 bg-muted/30 text-muted-foreground",
    dot: "bg-state-positive-solid",
    bar: "bg-state-positive-solid",
    text: "text-muted-foreground",
  },
  running: {
    label: "Running",
    pill: "border-state-info-solid/25 bg-state-info-subtle text-state-info-bright",
    dot: "bg-state-info-solid",
    bar: "bg-state-info-solid",
    text: "text-state-info-bright",
  },
  unavailable: {
    label: "Unavailable",
    pill: "border-dashed border-border bg-transparent text-muted-foreground",
    dot: "bg-muted-foreground/50",
    bar: "bg-muted-foreground/40",
    text: "text-muted-foreground",
  },
} as const satisfies Record<OperatorVerdict, StateToneClasses>;
