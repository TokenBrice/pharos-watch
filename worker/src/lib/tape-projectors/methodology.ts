/**
 * methodology.bumped:<domain> projectors.
 *
 * Source: the `*-version.ts` constants in `shared/lib/`. Each domain exposes a
 * changelog of `{ version, title, date, effectiveAt, summary, ... }` entries.
 *
 * Pattern: first-observation. For each domain we read the set of versions
 * already projected (one SELECT per domain) and emit a tape event for every
 * changelog entry whose version is not yet present. Re-running the projector
 * after the initial backfill is a near-no-op (one indexed SELECT per domain
 * plus zero writes when nothing has been published).
 *
 * The event type slug is `methodology.bumped:<domain>` per the wire grammar
 * in §3.3 of the implementation plan; `<domain>` is a short lowercase tag.
 */
import { BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG } from "@shared/lib/methodology-versions/blacklist-tracker";
import { CHAIN_HEALTH_METHODOLOGY_CHANGELOG } from "@shared/lib/methodology-versions/chain-health";
import { DEPEG_DEWS_METHODOLOGY_CHANGELOG } from "@shared/lib/methodology-versions/depeg-dews";
import { LIQUIDITY_METHODOLOGY_CHANGELOG } from "@shared/lib/liquidity-score-version";
import { MINT_BURN_FLOW_METHODOLOGY_CHANGELOG } from "@shared/lib/methodology-versions/mint-burn-flow";
import { PRICING_PIPELINE_METHODOLOGY_CHANGELOG } from "@shared/lib/methodology-versions/pricing-pipeline";
import { PSI_METHODOLOGY_CHANGELOG } from "@shared/lib/methodology-versions/stability-index";
import { REDEMPTION_BACKSTOP_METHODOLOGY_CHANGELOG } from "@shared/lib/redemption-backstop-version";
import { SAFETY_SCORE_METHODOLOGY_CHANGELOG } from "@shared/lib/methodology-versions/safety-score";
import { YIELD_METHODOLOGY_CHANGELOG } from "@shared/lib/methodology-versions/yield-methodology";
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
import { insertTapeEvents } from "../tape-event-store";
import type { TapeEventInsert } from "../tape-event-types";
import type { ProjectorOptions, ProjectorResult } from "./types";

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

async function loadObservedVersions(db: D1Database, type: string): Promise<Set<string>> {
  const result = await db
    .prepare(`SELECT source_row_id FROM tape_events WHERE type = ?`)
    .bind(type)
    .all<{ source_row_id: string }>();
  const seen = new Set<string>();
  for (const row of result.results ?? []) seen.add(row.source_row_id);
  return seen;
}

async function projectOneDomain(
  db: D1Database,
  spec: MethodologyDomain,
  dryRun: boolean,
): Promise<number> {
  const type = `methodology.bumped:${spec.domain}`;
  const observed = await loadObservedVersions(db, type);
  const events: TapeEventInsert[] = [];

  for (const entry of spec.changelog) {
    if (observed.has(entry.version)) continue;
    const tsSec = Number.isFinite(entry.effectiveAt) && entry.effectiveAt > 0
      ? entry.effectiveAt
      : Math.floor(Date.now() / 1000);
    const tsMs = tsSec * 1000;
    const sourceRowId = entry.version;
    const transition = "updated";
    const severity = severityForMethodologyBump(entry.version);

    events.push({
      eventId: buildTapeEventId({
        tsMs,
        type,
        sourceTable: `methodology:${spec.domain}`,
        sourceRowId,
        transition,
      }),
      type,
      severity,
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
      sourceRowId,
      transition,
      sourceUrl: spec.href,
      methodologyVersion: entry.version,
    });
  }

  if (events.length === 0) return 0;
  if (!dryRun) await insertTapeEvents(db, events);
  return events.length;
}

export async function projectMethodologyBumps(
  db: D1Database,
  options?: ProjectorOptions,
): Promise<ProjectorResult> {
  const dryRun = options?.dryRun === true;
  let total = 0;
  for (const spec of METHODOLOGY_DOMAINS) {
    total += await projectOneDomain(db, spec, dryRun);
  }
  return { projected: total, advanced: null };
}
