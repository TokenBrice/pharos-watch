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

type ProofOfReservesType = NonNullable<StablecoinMeta["proofOfReserves"]>["type"];

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

/** Proof-of-reserves badge styles for the detail page. */
export const POR_BADGE_STYLES: Record<ProofOfReservesType, BadgeStyle> = {
  "independent-audit": {
    label: "Independent Audit",
    cls: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20",
  },
  // A third-party engagement that expresses no assurance opinion: neutral
  // tone, never audit-blue.
  "agreed-upon-procedures": {
    label: "Agreed-Upon Procedures",
    cls: "bg-muted/40 text-muted-foreground border-border/60",
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

export const EVENT_BADGE_STYLES: Record<BlacklistEventType, string> = {
  blacklist: "bg-red-500/15 text-red-600 border-red-500/30 dark:text-red-400",
  unblacklist: "bg-emerald-500/15 text-emerald-600 border-emerald-500/20 dark:text-emerald-400",
  destroy: "bg-amber-500/15 text-amber-600 border-amber-500/30 dark:text-amber-400",
};

export const EVENT_LABELS: Record<BlacklistEventType, string> = {
  blacklist: "Freeze",
  unblacklist: "Release",
  destroy: "Wipe",
};

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
