import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

/**
 * V9 is activated under methodology `9.0`.
 */
export const SAFETY_SCORE_V9_ACTIVATION: MethodologyChangelogEntry = {
  version: "9.0",
  title: "Safety Score V9 becomes the active model",
  date: "2026-07-27",
  effectiveAt: 1785129044,
  summary:
    "Pharos activates the identity-bound V9 model with three risk pillars, explicit evidence responsibility, structural ceilings, and fail-closed publication health.",
  impact: [
    "All active consumers select V9 without recomputing or falling back to V8",
    "Backing, Exit, and Economic Control replace the five V8 dimensions for native V9 output",
    "Transient producer failures hold the last accepted V9 snapshot and expose held status instead of publishing infrastructure-attributed score movement",
    "Capability-free immutable protocol contracts resolve to immutable governance access posture instead of being mistaken for concentrated administrators",
    "V8.17 remains available only as historical methodology and archived score history",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_ROUTE_CAPACITY: MethodologyChangelogEntry = {
  version: "9.01",
  title: "Economically material route capacity",
  date: "2026-07-28",
  effectiveAt: 1785224355,
  summary:
    "Exit routes now need economically material capacity, and sub-1% completion cannot score above 50 even when the absolute-capacity floor is met.",
  impact: [
    "The prior threshold derived from two-decimal trace rounding is replaced by the policy's first positive 1% coverage or $100K absolute-capacity breakpoint",
    "A route below both breakpoints receives a zero route score; a route that reaches $100K but remains below 1% completion is capped at 50",
    "Public Exit breakdowns identify capacity as selected-route-specific and expose executable amount, request, cost bound, horizon, protocol, pool, evidence kind, and evidence time",
    "Issuer redemption remains a separate near-term or eventual horizon and is not inferred from exchange volume, aggregate DEX TVL, or issuer reserves",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_CAUSAL_RESPONSIBILITY: MethodologyChangelogEntry = {
  version: "9.02",
  title: "Causal responsibility provenance",
  date: "2026-07-28",
  effectiveAt: 1785234908,
  summary:
    "V9 now preserves causal responsibility through inherited and upstream evidence paths, distinguishes producer-unpriceable exit outputs from issuer non-disclosure, and retains reviewed controls in partial inventories without changing score or grade formulas.",
  impact: [
    "Explicit reason-level responsibility is authoritative; legacy reason defaults are used only when no explicit attribution is available",
    "Inherited reserve gaps, unavailable backing and role-pillar dependencies, and missing parent scores propagate the originating owner instead of defaulting downstream gaps to integration-missing",
    "Every attributed root receives a causal-root-qualified path even when it is the only root, so adding another root cannot rename an existing public fact; only unattributed fallbacks retain aggregate base paths, and mutable ownership never enters public fact identity",
    "Applicable but unpublished mechanism metrics retain issuer-undisclosed responsibility and never become measured-adverse merely because a related component was reviewed",
    "A reviewed external exit output with known identity but no same-notional valuation is producer-failed; an issuer-undisclosed settlement asset stays issuer-undisclosed, and neither output becomes scoreable",
    "Date-only mechanism and exit-output dispositions become admissible after the reviewed UTC day and cannot enter earlier replay clocks",
    "Reviewed mint controls remain present when the aggregate inventory is unresolved; unreviewed deployment surfaces stay bounded and fail closed",
    "Backing, Exit, and Economic Control weights, score aggregation, caps, and grade thresholds are unchanged",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_UNRECOGNIZED_CHAIN_LABEL_TOLERANCE: MethodologyChangelogEntry = {
  version: "9.03",
  title: "Subthreshold chain-label pool tolerance",
  date: "2026-07-29",
  effectiveAt: 1785341437,
  summary:
    "Subthreshold unrecognized chain-label supply pools remain tolerated by the bridge-materiality proof but no longer surface as public evidence-responsibility facts.",
  impact: [
    "Small raw provider chain-label pools below the common-mode materiality floor no longer create producer-failed remediation items",
    "Material unmatched bridge supply still fails closed through the ordinary bridge-supply reason at or above the materiality floor",
    "Backing, Exit, and Economic Control weights, score aggregation, caps, and grade thresholds are unchanged",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_UNSUPPORTED_EXIT_COVERAGE: MethodologyChangelogEntry = {
  version: "9.04",
  title: "Unsupported coverage separated from producer failure",
  date: "2026-07-29",
  effectiveAt: 1785353342,
  summary:
    "Exit-coverage, route-evidence, and dependency gaps that no supported adapter can observe are now attributed to unsupported methodology instead of transient producer failure, deployment census coverage is reported per chain, and a peg with no usable price but an adverse record becomes measured adverse.",
  impact: [
    "Deployment census coverage is evaluated per chain: deployments on chains with no supported liquidity provider are reported as an explicit unsupported remainder instead of leaving the whole asset's coverage unknown, so a clean supported scope publishes real coverage",
    "An exit surface with no retained pool, or with retained pools but no score-eligible execution-capability pool, is attributed to unsupported methodology when its census remainder is methodology-unsupported and no execution-capability gate applies; genuine producer failures keep producer-failed responsibility",
    "Runtime route evidence for that unsupported cohort is reported as unsupported rather than missing, so later adapter coverage silently returns those assets to scoring without a responsibility rewrite",
    "Unreviewed dependency relationships are unsupported methodology when the asset has no live-reserve adapter and remain producer-failed when one exists, correcting the misattributed hubble USDH dependency gap",
    "Zero-pool and zero-exact-capable exit surfaces carry their own gap messages; the reviewed-capability-pool message is now emitted only where reviewed execution-capability pools actually exist",
    "An asset with no usable current price whose tracked peg record is already adverse is classified as measured adverse instead of a producer feed failure, while a clean record with no usable price stays a quiet observation and the deviation is never coerced to zero",
    "The unreachable subthreshold unrecognized chain-label pool reason is retired from the reason registry",
    "Reclassified surfaces stay bounded and remain at the same evidence ceiling, so pillar weights, score aggregation, caps, and grade thresholds are unchanged and no published grade moves",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_WRAPPER_LOCAL_CONTROL_EVIDENCE: MethodologyChangelogEntry = {
  version: "9.05",
  title: "Wrapper local controls retain partial evidence",
  date: "2026-07-30",
  effectiveAt: 1785431359,
  summary:
    "Strategy-vault wrapper loss-control facts can now use reviewed local controls from a partial deployment inventory while unresolved controls remain bounded and risk-transfer credit remains disabled unless separately documented.",
  impact: [
    "Reviewed local controls on a strategy-vault wrapper populate the wrapper loss-absorption and emergency-control dimension even when the aggregate mint/control review is still bounded",
    "Unresolved deployment surfaces still fail closed in Economic Control and keep their original evidence responsibility",
    "Security-module, recovery-mode, and other local emergency controls do not create parent-loss absorption credit; wrapper risk-transfer remains zero unless a separate enforceable backstop is reviewed",
    "Backing, Exit, and Economic Control weights, score aggregation, caps, and grade thresholds are unchanged",
  ],
  commits: [],
  reconstructed: false,
};
