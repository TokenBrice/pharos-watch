import type {
  AttestorTier,
  BackingType,
  BlacklistEventType,
  BlacklistStablecoin,
  GovernanceType,
  PegCurrency,
  StablecoinMeta,
  YieldType,
} from "../../types";
import type { BadgeStyle, PegChartColor, PegMetadata } from "./common";
import { BACKING_DESCRIPTORS, GOVERNANCE_DESCRIPTORS, projectDescriptors } from "./descriptors";
import { mapPegMetadata, PEG_METADATA } from "./pegs";

// Combined label+class style maps (for detail page pill badges)
// ---------------------------------------------------------------------------

type ProofOfReserves = NonNullable<StablecoinMeta["proofOfReserves"]>;
type ProofOfReservesType = ProofOfReserves["type"];
type ProofAssuranceMethod = NonNullable<ProofOfReserves["latestReport"]>["assuranceMethod"];
type ProofAssuranceScope = NonNullable<ProofOfReserves["latestReport"]>["scope"];
type LiabilityReconciliation = NonNullable<ProofOfReserves["latestReport"]>["liabilityReconciliation"];

/** Governance badge styles for the detail page. */
export const GOVERNANCE_BADGE_STYLES: Record<GovernanceType, BadgeStyle> = projectDescriptors(
  GOVERNANCE_DESCRIPTORS,
  (descriptor) => ({ label: descriptor.badgeLabel, cls: descriptor.badgeCls }),
);

/** Backing badge styles for the detail page. */
export const BACKING_BADGE_STYLES: Record<BackingType, BadgeStyle> = projectDescriptors(
  BACKING_DESCRIPTORS,
  (descriptor) => ({ label: descriptor.badgeLabel, cls: descriptor.badgeCls }),
);

/** Peg currency badge styles for the detail page. */
export const PEG_BADGE_STYLES = mapPegMetadata((metadata) => metadata.badge);

/** Independent engagement with a reviewed assurance opinion: the audit-blue tone. */
const POR_INDEPENDENT_ENGAGEMENT_CLS = "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20";
/** A third-party engagement that expresses no assurance opinion: neutral, never audit-blue. */
const POR_NEUTRAL_ENGAGEMENT_CLS = "bg-muted/40 text-muted-foreground border-border/60";

/**
 * Storage-level fallback for the proof-of-reserves engagement. The
 * `independent-audit` storage type covers examinations, audits and unresolved
 * methods alike (26 examinations among 47 records were not audits), so the
 * raw label may not assert audit-grade assurance. `getProofOfReservesStyle`
 * names the reviewed `assuranceMethod` when it establishes one.
 */
export const POR_BADGE_STYLES: Record<ProofOfReservesType, BadgeStyle> = {
  // Never audit-blue by default: only a reviewed audit or examination method
  // earns the engagement tone in `getProofOfReservesStyle`.
  "independent-audit": {
    label: "Independent Report",
    cls: POR_NEUTRAL_ENGAGEMENT_CLS,
  },
  // A third-party engagement that expresses no assurance opinion: neutral
  // tone, never audit-blue.
  "agreed-upon-procedures": {
    label: "Agreed-Upon Procedures",
    cls: POR_NEUTRAL_ENGAGEMENT_CLS,
  },
  // Independent verification-agent report: below audit-grade assurance.
  attestation: {
    label: "Independent Attestation",
    cls: "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/20",
  },
  "real-time": {
    label: "Real-Time PoR",
    cls: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
  },
  "self-reported": {
    label: "Self-Reported PoR",
    cls: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
  },
};

/** Reviewed assurance methods that establish an opinion-graded engagement. */
const POR_ASSURANCE_METHOD_LABELS: Partial<Record<ProofAssuranceMethod, string>> = {
  audit: "Audit",
  examination: "Examination",
};

/**
 * Presentation resolver shared by every proof-of-reserves surface. The
 * storage type alone cannot distinguish an examination from an audit, so an
 * `independent-audit` record is named by its reviewed `assuranceMethod`; an
 * unknown, absent or non-opinion method stays a neutral "Independent Report".
 * Absent proof returns `null`, leaving the caller's existing absence copy.
 * Presentation only: the proof object is never modified and the scoring
 * eligibility read of the same method is untouched.
 */
export function getProofOfReservesStyle(
  proof: StablecoinMeta["proofOfReserves"] | null,
): BadgeStyle | null {
  if (!proof) return null;
  const style = POR_BADGE_STYLES[proof.type];
  if (proof.type !== "independent-audit") return style;
  const methodLabel = proof.latestReport ? POR_ASSURANCE_METHOD_LABELS[proof.latestReport.assuranceMethod] : undefined;
  return methodLabel ? { label: methodLabel, cls: POR_INDEPENDENT_ENGAGEMENT_CLS } : style;
}

/**
 * Reviewed report-method vocabulary for structured scope rows. This projects
 * the recorded `latestReport.assuranceMethod` field itself; it is not a
 * substitute engagement label. `getProofOfReservesStyle` deliberately keeps
 * non-opinion methods neutral (`Independent Report`), while a scope row must
 * name the recorded method so an attestation is never silently promoted.
 */
export const PROOF_ASSURANCE_METHOD_LABELS: Record<ProofAssuranceMethod, string> = {
  audit: "Audit",
  examination: "Examination",
  review: "Review",
  "agreed-upon-procedures": "Agreed-upon procedures",
  attestation: "Attestation",
  "onchain-proof": "Onchain proof",
  "self-verification": "Self-verification",
  unknown: "Method not established",
};

/** Report-scope phrases for compact evidence rows. */
export const PROOF_ASSURANCE_SCOPE_LABELS: Record<ProofAssuranceScope, string> = {
  "assets-only": "assets only",
  "assets-and-liabilities": "assets and liabilities",
  unknown: "scope unknown",
};

/** Liability-reconciliation phrases for compact evidence rows. */
export const LIABILITY_RECONCILIATION_LABELS: Record<LiabilityReconciliation, string> = {
  full: "full liability reconciliation",
  partial: "partial liability reconciliation",
  none: "no liability reconciliation",
  unknown: "liability reconciliation unknown",
};

/**
 * Proof-of-reserves attestor tier badge styles for the detail page.
 * `textCls` is the text-only projection of the same ladder for flat surfaces
 * (hero passport entries) that carry no pill background.
 */
export const POR_TIER_STYLES: Record<AttestorTier, { cls: string; label: string; textCls: string }> = {
  big4: {
    cls: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
    label: "Big-4 attestor",
    textCls: "text-emerald-700 dark:text-emerald-400",
  },
  regional: {
    cls: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/30",
    label: "Regional CPA",
    textCls: "text-blue-700 dark:text-blue-400",
  },
  niche: {
    cls: "bg-muted/40 text-muted-foreground border-border/60",
    label: "Niche attestor",
    textCls: "text-muted-foreground",
  },
  self: {
    cls: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30",
    label: "Self-attested",
    textCls: "text-amber-700 dark:text-amber-400",
  },
  none: {
    cls: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/30",
    label: "No attestation",
    textCls: "text-red-700 dark:text-red-400",
  },
  // Absence of evidence, not evidence of absence: the issuer names no attestor
  // or the claimed artefact is unreachable. It takes the dashed-muted "nothing
  // here yet" idiom rather than an alarm tone, because an undisclosed attestor
  // is an unanswered question and only a reviewed negative (`none`) may assert
  // that no attestation exists.
  undisclosed: {
    cls: "bg-muted/20 text-muted-foreground border-dashed border-border/60",
    label: "Not disclosed",
    textCls: "text-muted-foreground",
  },
};

// ---------------------------------------------------------------------------
// Blacklist event badge styles
// ---------------------------------------------------------------------------

const EVENT_DESCRIPTORS = {
  blacklist: {
    label: "Freeze",
    badgeCls: "bg-red-500/15 text-red-600 border-red-500/30 dark:text-red-400",
    chartColor: "#ef4444",
  },
  unblacklist: {
    label: "Release",
    badgeCls: "bg-emerald-500/15 text-emerald-600 border-emerald-500/20 dark:text-emerald-400",
    chartColor: "#10b981",
  },
  destroy: {
    label: "Wipe",
    badgeCls: "bg-amber-500/15 text-amber-600 border-amber-500/30 dark:text-amber-400",
    chartColor: "#f59e0b",
  },
} as const satisfies Record<BlacklistEventType, { label: string; badgeCls: string; chartColor: string }>;

export const EVENT_BADGE_STYLES: Record<BlacklistEventType, string> = projectDescriptors(
  EVENT_DESCRIPTORS,
  (descriptor) => descriptor.badgeCls,
);

export const EVENT_LABELS: Record<BlacklistEventType, string> = projectDescriptors(
  EVENT_DESCRIPTORS,
  (descriptor) => descriptor.label,
);

/** Solid chart fills share the event badge semantics in both themes. */
export const EVENT_CHART_COLORS: Record<BlacklistEventType, string> = projectDescriptors(
  EVENT_DESCRIPTORS,
  (descriptor) => descriptor.chartColor,
);

// ---------------------------------------------------------------------------
// Peg currency chart colors (text + bg pairs for charts and stat cards)
// ---------------------------------------------------------------------------

export const PEG_CHART_COLORS = Object.fromEntries(
  (Object.entries(PEG_METADATA) as [PegCurrency, PegMetadata][]).flatMap(([peg, metadata]) =>
    metadata.chart ? [[peg, metadata.chart]] : [],
  ),
) as Record<string, PegChartColor>;

// ---------------------------------------------------------------------------
// Yield type labels & styles
// ---------------------------------------------------------------------------

export const YIELD_TYPE_LABELS: Record<YieldType, string> = {
  "lending-vault": "Native",
  rebase: "Rebase",
  "fee-sharing": "Fee Share",
  "lp-receipt": "LP Receipt",
  "nav-appreciation": "NAV",
  "governance-set": "Gov. Set",
  "lending-opportunity": "Lending Opp.",
  "fixed-yield": "Fixed Yield",
  "structured-tranche": "Structured Tranche",
};

export const YIELD_TYPE_STYLES: Record<YieldType, { badge: string; hex: string }> = {
  "lending-vault": {
    badge: "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/20",
    hex: "#f97316",
  },
  rebase: { badge: "bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-500/20", hex: "#8b5cf6" },
  "fee-sharing": { badge: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-400 border-cyan-500/20", hex: "#06b6d4" },
  "lp-receipt": { badge: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20", hex: "#f59e0b" },
  "nav-appreciation": {
    badge: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
    hex: "#10b981",
  },
  "governance-set": {
    badge: "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/20",
    hex: "#f97316",
  },
  "lending-opportunity": { badge: "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/20", hex: "#0ea5e9" },
  "fixed-yield": { badge: "bg-indigo-500/10 text-indigo-700 dark:text-indigo-400 border-indigo-500/20", hex: "#6366f1" },
  "structured-tranche": { badge: "bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/20", hex: "#e11d48" },
};

/**
 * Joint safety × yield reading shared by the /yield scatter quadrants and the
 * per-row zone chip. Split at safety 60 and the row's own benchmark rate.
 * PYS says how well a row pays for its risk; the zone says whether that risk
 * is one a reader should be taking at all.
 */
export type YieldZoneKey = "sweet-spot" | "danger-zone" | "play-it-safe" | "why-bother";

export const YIELD_ZONE_LABELS: Record<YieldZoneKey, string> = {
  "sweet-spot": "Sweet Spot",
  "danger-zone": "Danger Zone",
  "play-it-safe": "Play It Safe",
  "why-bother": "Why Bother?",
};

export const YIELD_ZONE_DESCRIPTIONS: Record<YieldZoneKey, string> = {
  "sweet-spot": "Safety 60+ and APY above its benchmark: paid to hold a safer coin.",
  "danger-zone": "Safety below 60 with APY above its benchmark: well-paid risk, not a safe pick.",
  "play-it-safe": "Safety 60+ but APY at or below its benchmark: safe, underpaid.",
  "why-bother": "Safety below 60 and APY at or below its benchmark: risk without pay.",
};

export const YIELD_ZONE_STYLES: Record<YieldZoneKey, { badge: string; dot: string }> = {
  "sweet-spot": { badge: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20", dot: "bg-emerald-500" },
  "danger-zone": { badge: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/30", dot: "bg-red-500" },
  "play-it-safe": { badge: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20", dot: "bg-blue-500" },
  "why-bother": { badge: "bg-slate-500/10 text-slate-700 dark:text-slate-400 border-slate-500/20", dot: "bg-slate-500" },
};

/** Legend dot for yield points pinned above the scatter plot's APY clip. */
export const YIELD_ZONE_OUTLIER_DOT_CLASS = "bg-amber-500";

/** Chart hex colors for blacklist stablecoin breakdown.
 *  Intentionally per-stablecoin brand colors — independent of chart-colors.ts tokens. */
export const BLACKLIST_CHART_COLORS: Record<BlacklistStablecoin, string> = {
  USDT: "#06b6d4",
  USDC: "#3b82f6",
  PYUSD: "#6366f1",
  USD1: "#c026d3",
  USDG: "#14b8a6",
  RLUSD: "#e11d48",
  U: "#22c55e",
  USDTB: "#8b5cf6",
  A7A5: "#64748b",
  FDUSD: "#0f766e",
  BRZ: "#16a34a",
  EURC: "#1d4ed8",
  AUSD: "#0891b2",
  EURI: "#2563eb",
  USDQ: "#7c3aed",
  USDO: "#059669",
  USDX: "#dc2626",
  AID: "#9333ea",
  TGBP: "#be123c",
  BUIDL: "#111827",
  USDP: "#0ea5e9",
  PAXG: "#eab308",
  XAUT: "#f59e0b",
  TUSD: "#0284c7",
  NUSD: "#7c2d12",
  EURCV: "#1e3a8a",
  USDA: "#15803d",
  USAT: "#a21caf",
  AEUR: "#1e40af",
  XUSD: "#0e7490",
  XAUM: "#ca8a04",
  JPYC: "#ea580c",
  FRXUSD: "#f97316",
  FIDD: "#166534",
};

// ---------------------------------------------------------------------------
