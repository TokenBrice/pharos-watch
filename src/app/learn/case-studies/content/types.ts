import type { MechanismArchetype } from "@shared/types";

/**
 * Long-form depeg / failure retrospectives that sit *above* the per-incident
 * `/depeg/[event]/` records, the `/cemetery/` obituaries, and the curated chart
 * annotations. A case study links down into those layers — it never restates
 * them verbatim. See `agents/learn-case-studies-plan.md`.
 */

/** survived = recovered to peg; wounded = still live but structurally scarred; died = decommissioned. */
export type CaseStudyOutcome = "survived" | "wounded" | "died";

/** Severity vocabulary matches the chart-annotation tape (`high` / `med` / `low`). */
export type CaseStudySeverity = "high" | "med" | "low";

export interface CaseStudySource {
  readonly label: string;
  /** Primary source — issuer post-mortem, regulator filing, rekt.news, etc. */
  readonly href: string;
}

export interface CaseStudyTimelineEntry {
  /** ISO date; day precision is fine ("2023-03-11"). Drives chronological order. */
  readonly dateISO: string;
  readonly headline: string;
  /** 1–3 sentences expanding the headline. Numbers must match the recorded event. */
  readonly body: string;
  readonly severity?: CaseStudySeverity;
  readonly href?: string;
}

export interface CaseStudySection {
  readonly heading: string;
  readonly paragraphs: readonly string[];
}

/**
 * Live Pharos chart embedded in the body. Hydrates client-side via
 * `useSupplyHistory(coinId)` (fine under static export) and overlays the coin's
 * curated annotations. Only populate for data-rich (≈2024+) coins where a real
 * series exists; omit for pre-collection historical events.
 */
export interface CaseStudyDataWidget {
  readonly kind: "peg-deviation";
  readonly coinId: string;
  readonly caption: string;
}

export interface CaseStudyCrossLink {
  readonly href: string;
  readonly label: string;
}

export interface CaseStudyRelatedCoin {
  /** Must match a `shared/data/stablecoins/coins/<id>.json` filename. */
  readonly coinId: string;
  readonly note: string;
}

export interface CaseStudy {
  /** URL slug → /learn/case-studies/<slug>/. Also the content filename. */
  readonly slug: string;
  /** Short category kicker, e.g. "Algorithmic collapse" or "Reserve banking shock". */
  readonly eyebrow: string;
  readonly title: string;
  /** One-sentence standfirst; also the hub-card summary (line-clamped). */
  readonly subtitle: string;
  readonly lead: readonly string[];
  /** Optional 3–4 bullet TL;DR, rendered as a "Key takeaways" block above the chart. */
  readonly takeaways?: readonly string[];

  /**
   * Tracked coin id (matches `shared/data/stablecoins/coins/<id>.json`). Links to
   * `/stablecoin/<id>` and enables chart widgets. Omit for cemetery-only coins
   * (e.g. UST, IRON, FEI) that have no tracked page — use `cemeteryId` instead.
   * At least one of `primaryCoinId` / `cemeteryId` must be set.
   */
  readonly primaryCoinId?: string;
  readonly relatedCoins?: readonly CaseStudyRelatedCoin[];
  readonly archetype: MechanismArchetype;
  readonly outcome: CaseStudyOutcome;

  /** Human label for cards/meta, e.g. "March 2023". */
  readonly eventDateLabel: string;
  readonly eventWindow: {
    readonly startISO: string;
    readonly endISO?: string;
    readonly peakDeviationBps?: number;
    readonly lowPrice?: number;
  };

  /** Optional cross-links into existing layers — validated at build (see index.ts test). */
  readonly depegEventSlug?: string;
  readonly cemeteryId?: string;

  readonly timeline: readonly CaseStudyTimelineEntry[];
  readonly sections: readonly CaseStudySection[];
  readonly dataWidgets?: readonly CaseStudyDataWidget[];
  readonly watchpoints: readonly string[];
  readonly crossLinks: readonly CaseStudyCrossLink[];
  readonly sources: readonly CaseStudySource[];

  /** ≤160 chars for <meta description>. */
  readonly metaDescription: string;
  /** ISO datePublished anchor for Article JSON-LD. */
  readonly datePublished: string;
}
