/**
 * methodology.bumped:<domain> projectors.
 *
 * Source: the `*-version.ts` constants in `shared/lib/`. Each domain exposes a
 * changelog of `{ version, title, date, effectiveAt, summary, ... }` entries.
 *
 * Pattern: first-observation plus in-place clock/payload reconciliation. Each
 * bounded changelog is driven through the static-catalog projector to insert
 * unseen entries, then reconciled against existing `tape_events` rows so
 * post-deploy `effectiveAt` re-dates update `ts` and `payload_json` without
 * replacing `event_id` permalinks or reviving suppressed rows.
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
import type { MethodologyChangelogEntry } from "@shared/types/editorial-content";

import { runWithOverloadRetry } from "../d1-overload-retry";
import { batchExecute } from "../db";
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

interface ExistingMethodologyRow {
  event_id: string;
  source_row_id: string;
  ts: number;
  title: string;
  summary: string | null;
  severity: string;
  payload_effective_at: number | null;
  payload_date: string | null;
  payload_chars: number | null;
}

const METHODOLOGY_TRANSITION = "updated";

function hasValidEffectiveAt(entry: MethodologyChangelogEntry): boolean {
  return Number.isSafeInteger(entry.effectiveAt) && entry.effectiveAt > 0;
}

function validChangelogEntries(spec: MethodologyDomain): MethodologyChangelogEntry[] {
  const valid: MethodologyChangelogEntry[] = [];
  for (const entry of spec.changelog) {
    if (!hasValidEffectiveAt(entry)) {
      console.warn(
        `[project-tape] Skipping methodology entry ${spec.domain} v${entry.version}: invalid effectiveAt (${String(entry.effectiveAt)})`,
      );
      continue;
    }
    valid.push(entry);
  }
  return valid;
}

function buildMethodologyEvent(
  spec: MethodologyDomain,
  entry: MethodologyChangelogEntry,
): TapeEventInsert {
  const type = `methodology.bumped:${spec.domain}`;
  const tsMs = entry.effectiveAt * 1000;

  return {
    eventId: buildTapeEventId({
      tsMs,
      type,
      sourceTable: `methodology:${spec.domain}`,
      sourceRowId: entry.version,
      transition: METHODOLOGY_TRANSITION,
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
    transition: METHODOLOGY_TRANSITION,
    sourceUrl: spec.href,
    methodologyVersion: entry.version,
  };
}

export async function projectMethodologyBumps(
  db: D1Database,
  options?: ProjectorOptions,
): Promise<ProjectorResult> {
  let total = 0;
  const validByDomain: Array<{ spec: MethodologyDomain; entries: MethodologyChangelogEntry[] }> = [];
  for (const spec of METHODOLOGY_DOMAINS) {
    const entries = validChangelogEntries(spec);
    if (entries.length === 0) continue;
    validByDomain.push({ spec, entries });
    const result = await projectStaticCatalogEntries(db, {
      entries,
      buildEvent: (entry) => buildMethodologyEvent(spec, entry),
    }, options);
    total += result.projected;
  }

  if (options?.dryRun !== true && validByDomain.length > 0) {
    const existingResults = await runWithOverloadRetry(
      () =>
        db.batch<ExistingMethodologyRow>(
          validByDomain.map(({ spec }) =>
            db.prepare(
              `SELECT event_id, source_row_id, ts, title, summary, severity,
                      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.effectiveAt') END AS payload_effective_at,
                      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.date') END AS payload_date,
                      length(payload_json) AS payload_chars
                 FROM tape_events INDEXED BY idx_tape_source_key
                WHERE source_table = ? AND transition = ? AND type = ?`,
            ).bind(`methodology:${spec.domain}`, METHODOLOGY_TRANSITION, `methodology.bumped:${spec.domain}`),
          ),
        ),
      3,
    );
    const updates: D1PreparedStatement[] = [];
    for (let index = 0; index < validByDomain.length; index += 1) {
      const { spec, entries } = validByDomain[index]!;
      const existingRows = existingResults[index]?.results ?? [];
      if (existingRows.length === 0) continue;
      const existingByVersion = new Map(existingRows.map((row) => [row.source_row_id, row]));
      for (const entry of entries) {
        const existing = existingByVersion.get(entry.version);
        if (!existing) continue;
        const event = buildMethodologyEvent(spec, entry);
        const expectedPayloadJson = JSON.stringify(event.payload);
        const expectedPayloadChars = Array.from(expectedPayloadJson).length;
        if (
          existing.ts !== event.ts ||
          existing.title !== event.title ||
          existing.summary !== event.summary ||
          existing.severity !== event.severity ||
          existing.payload_effective_at !== entry.effectiveAt ||
          existing.payload_date !== entry.date ||
          existing.payload_chars !== expectedPayloadChars
        ) {
          updates.push(
            db.prepare(
              `UPDATE tape_events SET ts = ?, title = ?, summary = ?, severity = ?, payload_json = ? WHERE event_id = ?`,
            ).bind(event.ts, event.title, event.summary, event.severity, expectedPayloadJson, existing.event_id),
          );
        }
      }
    }
    if (updates.length > 0) {
      await batchExecute(db, updates);
    }
  }

  return { projected: total, advanced: null };
}
