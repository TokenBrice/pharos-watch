/**
 * methodology.bumped:<domain> projectors.
 *
 * Source: the `*-version.ts` constants in `shared/lib/`. Each domain exposes a
 * changelog of `{ version, title, date, effectiveAt, summary, ... }` entries.
 *
 * Pattern: first-observation. Each bounded changelog is driven through the
 * static-catalog projector, which probes source identities through the unique
 * Tape source-key index and emits only entries not yet present.
 *
 * The event type slug is `methodology.bumped:<domain>` per the wire grammar
 * in §3.3 of the implementation plan; `<domain>` is a short lowercase tag.
 */
import {
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG,
  CHAIN_HEALTH_METHODOLOGY_CHANGELOG,
  DEPEG_DEWS_METHODOLOGY_CHANGELOG,
  LIQUIDITY_METHODOLOGY_CHANGELOG,
  MINT_BURN_FLOW_METHODOLOGY_CHANGELOG,
  PRICING_PIPELINE_METHODOLOGY_CHANGELOG,
  PSI_METHODOLOGY_CHANGELOG,
  REDEMPTION_BACKSTOP_METHODOLOGY_CHANGELOG,
  SAFETY_SCORE_METHODOLOGY_CHANGELOG,
  YIELD_METHODOLOGY_CHANGELOG,
} from "@shared/lib/methodology-versions/registry";
import {
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
  CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
  DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
  MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
  PRICING_PIPELINE_METHODOLOGY_CHANGELOG_PATH,
  PSI_METHODOLOGY_CHANGELOG_PATH,
  REDEMPTION_BACKSTOP_METHODOLOGY_PATH,
  SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
  YIELD_METHODOLOGY_CHANGELOG_PATH,
} from "@shared/lib/methodology-versions/constants";
import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

import {
  buildTapeEventId,
  severityForMethodologyBump,
  truncateSummary,
} from "../tape-event-helpers";
import type { TapeEventInsert } from "../tape-event-types";
import {
  projectStaticCatalogEntries,
  type ProjectorOptions,
  type ProjectorResult,
} from "./types";

interface MethodologyDomain {
  /** Short lowercase tag used in the wire slug `methodology.bumped:<domain>`. */
  domain: string;
  /** Display label inside the event title. */
  label: string;
  /** Public changelog route (relative path). */
  href: string;
  changelog: readonly MethodologyChangelogEntry[];
}

const METHODOLOGY_DOMAINS: readonly MethodologyDomain[] = [
  {
    domain: "blacklist-tracker",
    label: "Blacklist Tracker",
    href: BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
    changelog: BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG,
  },
  {
    domain: "chain-health",
    label: "Chain Health",
    href: CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
    changelog: CHAIN_HEALTH_METHODOLOGY_CHANGELOG,
  },
  {
    domain: "depeg-dews",
    label: "Depeg & DEWS",
    href: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
    changelog: DEPEG_DEWS_METHODOLOGY_CHANGELOG,
  },
  {
    domain: "liquidity-score",
    label: "Liquidity Score",
    href: LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
    changelog: LIQUIDITY_METHODOLOGY_CHANGELOG,
  },
  {
    domain: "mint-burn-flow",
    label: "Mint/Burn Flow",
    href: MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
    changelog: MINT_BURN_FLOW_METHODOLOGY_CHANGELOG,
  },
  {
    domain: "pricing-pipeline",
    label: "Pricing Pipeline",
    href: PRICING_PIPELINE_METHODOLOGY_CHANGELOG_PATH,
    changelog: PRICING_PIPELINE_METHODOLOGY_CHANGELOG,
  },
  {
    domain: "redemption-backstop",
    label: "Redemption Backstop",
    href: REDEMPTION_BACKSTOP_METHODOLOGY_PATH,
    changelog: REDEMPTION_BACKSTOP_METHODOLOGY_CHANGELOG,
  },
  {
    domain: "safety-score",
    label: "Safety Score",
    href: SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
    changelog: SAFETY_SCORE_METHODOLOGY_CHANGELOG,
  },
  {
    domain: "stability-index",
    label: "Pharos Stability Index",
    href: PSI_METHODOLOGY_CHANGELOG_PATH,
    changelog: PSI_METHODOLOGY_CHANGELOG,
  },
  {
    domain: "yield",
    label: "Yield Intelligence",
    href: YIELD_METHODOLOGY_CHANGELOG_PATH,
    changelog: YIELD_METHODOLOGY_CHANGELOG,
  },
];

function buildMethodologyEvent(
  spec: MethodologyDomain,
  entry: MethodologyChangelogEntry,
): TapeEventInsert {
  const type = `methodology.bumped:${spec.domain}`;
  const tsSec = Number.isFinite(entry.effectiveAt) && entry.effectiveAt > 0
    ? entry.effectiveAt
    : Math.floor(Date.now() / 1000);
  const tsMs = tsSec * 1000;
  const transition = "updated";

  return {
    eventId: buildTapeEventId({
      tsMs,
      type,
      sourceTable: `methodology:${spec.domain}`,
      sourceRowId: entry.version,
      transition,
    }),
    type,
    severity: severityForMethodologyBump(entry.version),
    ts: tsMs,
    endsAt: null,
    coinId: null,
    issuerId: null,
    pegCurrency: null,
    chain: null,
    title: `${spec.label} v${entry.version}: ${entry.title}`,
    summary: truncateSummary(entry.summary),
    payload: {
      domain: spec.domain,
      version: entry.version,
      title: entry.title,
      date: entry.date,
      effectiveAt: entry.effectiveAt,
      impact: entry.impact,
    },
    sourceTable: `methodology:${spec.domain}`,
    sourceRowId: entry.version,
    transition,
    sourceUrl: spec.href,
    methodologyVersion: entry.version,
  };
}

export async function projectMethodologyBumps(
  db: D1Database,
  options?: ProjectorOptions,
): Promise<ProjectorResult> {
  let total = 0;
  for (const spec of METHODOLOGY_DOMAINS) {
    const result = await projectStaticCatalogEntries(db, {
      eventType: `methodology.bumped:${spec.domain}`,
      entries: spec.changelog,
      sourceRowId: (entry) => entry.version,
      buildEvent: (entry) => buildMethodologyEvent(spec, entry),
    }, options);
    total += result.projected;
  }
  return { projected: total, advanced: null };
}
