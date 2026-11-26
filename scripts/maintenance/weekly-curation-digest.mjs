#!/usr/bin/env node
// Boundary waiver: curation-digest-expiry-lookahead. See docs/process/boundary-waivers.md.
/**
 * Human-readable weekly curation rollup. Prints a structured markdown
 * digest covering each editorial stream tracked by Pharos:
 *
 *   1. Active coin-notice health (expired deadlines, invalid dates,
 *      missing sources, and NOTICE_STALE_DAYS staleness)
 *   2. oneLiner coverage (binary: 100% expected)
 *   3. mechanismArchetype coverage in the top-segment cohort
 *   4. proofOfReserves.attestorTier coverage (independent-audit cohort)
 *   5. AI summary staleness (>180 days for active coins)
 *   6. Chart annotation queue health
 *   7. Dated-review expiry lookahead (14 days, across all dated registries)
 *
 * Pure stdout by default. With --write the digest is also archived to
 * `agents/curation-digest-<date>.md`.
 *
 * Standalone command (`npm run digest:curation`). NOT part of CI. The
 * scheduled full test suite enforces the editorial floors; the digest is the
 * human rollup read on a calendar cadence.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CHAIN_MATURITY_REVIEWS_V1 } from "../../shared/data/safety-score-v9/chain-maturity-reviews-v1.ts";
import { NOTICE_STALE_DAYS } from "../../shared/lib/coin-state.ts";
import { DEX_COVERAGE_WAIVERS } from "../../shared/lib/dex-deployment-coverage.ts";
import {
  VENUE_RISK_SCORE_MAX_AGE_DAYS,
  YIELD_DEPENDENCY_CONCENTRATION,
  YIELD_RISK_CONFIG,
  findStaleVenueRiskScoresByEntries,
} from "../../shared/lib/yield-source-risk-registry.ts";
import { REVIEWED_CHAIN_TVL_DISPOSITIONS } from "../../worker/src/cron/dex-liquidity/orchestrator-drift.ts";
import { REVIEWED_POOL_REJECTION_ANCHOR_CORRECTION } from "../../worker/src/cron/dex-liquidity/reviewed-anchor-correction.ts";
import { REVIEWED_CHAIN_SUPPLY_COLLAPSES } from "../../worker/src/cron/sync-stablecoins/chain-dropout-seed.ts";
import {
  DEPEG_BLIND_EVENT_REVIEWS,
  DEPEG_NO_PARITY_QUOTE_REVIEWS,
} from "../../worker/src/lib/canary-checks-depeg.ts";
import { RESERVE_FEED_REVIEWS } from "../../worker/src/lib/reserve-feed-reviews.ts";
import {
  PSI_HISTORICAL_PRICE_GAP_REVIEWS,
  STABLECOIN_MARKET_HOURS_CALENDARS,
  STABLECOIN_PRICE_GAP_REVIEWS,
  STABLECOIN_PUBLICATION_WAIVERS,
} from "../../worker/src/lib/stablecoin-publication-reviews.ts";
import {
  REVIEWED_SUPPLY_CARRIES,
  REVIEWED_SUPPLY_VALUE_REBASELINES,
} from "../../worker/src/lib/supply-integrity.ts";
import { YIELD_ADAPTER_LIFECYCLE } from "../../worker/src/lib/yield-config/yield-config-rate-sources.ts";
import { YIELD_OPPORTUNITY_EXCLUSIONS } from "../../worker/src/lib/yield-config/yield-opportunity-exclusions.ts";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const ROOT = process.cwd();
const COINS_FILE = resolve(ROOT, "shared/data/stablecoins/coins.generated.json");
const SUMMARIES_FILE = resolve(ROOT, "data/ai-summaries.json");
const BASELINE_FILE = resolve(ROOT, "scripts/lib/curation-baseline-caps.json");
const CANDIDATES_FILE = resolve(ROOT, "agents/annotation-candidates.md");
const CURATED_ANNOTATIONS_DIR = resolve(ROOT, "shared/data/annotations/coins");

const DAY_MS = 24 * 60 * 60 * 1000;
const AI_SUMMARY_STALENESS_DAYS = 180;
const QUEUE_WARN_ROW_THRESHOLD = 30;
const QUEUE_WARN_AGE_DAYS = 60;
const ANNOTATION_STALE_YEARS = 2;
const QUARTERLY_HAND_CHECK_DAYS = 90;
export const EXPIRY_LOOKAHEAD_DAYS = 14;
// Per-bucket bullet cap so a staleness wave cannot push later digest sections
// past the workflow's 180-line excerpt.
const MAX_NOTICE_HEALTH_ROWS = 10;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readTextOrEmpty(path) {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

function parseArgs(argv) {
  return { write: argv.includes("--write") };
}

function status(coin) {
  return coin.status ?? "active";
}

function isActiveOrPreLaunch(coin) {
  const s = status(coin);
  return s === "active" || s === "pre-launch";
}

function isVariant(coin) {
  return typeof coin.variantOf === "string" && coin.variantOf.length > 0;
}

export function analyzeOneLiner(coins) {
  const inScope = coins.filter(isActiveOrPreLaunch);
  const missing = inScope
    .filter((c) => !c.oneLiner || String(c.oneLiner).trim() === "")
    .map((c) => c.id)
    .sort();
  return { total: inScope.length, missing };
}

export function analyzeArchetype(coins, baseline) {
  const byId = new Map(coins.map((c) => [c.id, c]));
  const tracked = [];
  let variants = 0;
  let frozen = 0;
  const unknown = [];
  for (const id of baseline.topByRank) {
    const coin = byId.get(id);
    if (!coin) {
      unknown.push(id);
      continue;
    }
    if (status(coin) === "frozen") {
      frozen += 1;
      continue;
    }
    if (isVariant(coin)) {
      variants += 1;
      continue;
    }
    tracked.push(coin);
  }
  const missing = tracked
    .filter((c) => !c.mechanismArchetype)
    .map((c) => c.id)
    .sort();
  return {
    segment: baseline.segmentLabel,
    segmentTotal: baseline.topByRank.length,
    tracked: tracked.length,
    variants,
    frozen,
    unknown,
    missing,
  };
}

export function analyzeAttestorTier(coins) {
  const auditCoins = coins.filter((c) => c.proofOfReserves && c.proofOfReserves.type === "independent-audit");
  const missing = auditCoins
    .filter((c) => !c.proofOfReserves || !c.proofOfReserves.attestorTier)
    .map((c) => c.id)
    .sort();
  return { total: auditCoins.length, missing };
}

function daysBetween(aIso, bIso) {
  const a = Date.parse(`${aIso}T00:00:00Z`);
  const b = Date.parse(`${bIso}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function analyzeSummaryStaleness(coins, summaries) {
  const today = todayIso();
  const stale = [];
  const missing = [];
  for (const coin of coins) {
    if (status(coin) !== "active") continue;
    const entry = summaries[coin.id];
    if (!entry || typeof entry.text !== "string" || entry.text.trim() === "") {
      missing.push(coin.id);
      continue;
    }
    const updated = typeof entry.updatedAt === "string" ? entry.updatedAt : "";
    const age = updated ? daysBetween(updated, today) : null;
    if (age == null || age > AI_SUMMARY_STALENESS_DAYS) {
      const hasNotice = Array.isArray(coin.notices) && coin.notices.length > 0;
      const hasFrozenObit = typeof coin.frozenAt === "string";
      stale.push({
        id: coin.id,
        ageDays: age,
        lastUpdate: updated || "(unknown)",
        flag: hasNotice
          ? "has notices — refresh likely warranted"
          : hasFrozenObit
            ? "frozen — past-tense refresh due"
            : "",
      });
    }
  }
  stale.sort((a, b) => (b.ageDays ?? Number.POSITIVE_INFINITY) - (a.ageDays ?? Number.POSITIVE_INFINITY));
  missing.sort();
  return { stale, missing };
}

function readCuratedAnnotationTimestamps() {
  const timestamps = [];
  if (!existsSync(CURATED_ANNOTATIONS_DIR)) return timestamps;
  const files = readdirSync(CURATED_ANNOTATIONS_DIR)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort();
  for (const fileName of files) {
    const entries = readJson(resolve(CURATED_ANNOTATIONS_DIR, fileName));
    if (!Array.isArray(entries)) {
      throw new Error(`Curated annotation source is not an array: ${fileName}`);
    }
    for (const [index, entry] of entries.entries()) {
      const date = entry && typeof entry.date === "string" ? entry.date : "";
      const iso = date.length === 10 ? `${date}T00:00:00.000Z` : date;
      const ts = Date.parse(iso);
      if (!Number.isFinite(ts)) {
        throw new Error(`Invalid curated annotation date: ${fileName}[${index}]`);
      }
      timestamps.push(ts);
    }
  }
  return timestamps;
}

function analyzeAnnotationQueue(queueText, curatedTimestamps) {
  const lines = queueText.split(/\r?\n/);
  let rowCount = 0;
  let oldestDate = null;
  const dateHeaderRe = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/;
  let activeDate = null;
  for (const line of lines) {
    const header = dateHeaderRe.exec(line);
    if (header) {
      activeDate = header[1];
      if (oldestDate == null || activeDate < oldestDate) oldestDate = activeDate;
      continue;
    }
    if (line.startsWith("- ") && line.includes(" | ")) {
      rowCount += 1;
    }
  }

  const ts = curatedTimestamps;
  const cutoffMs = Date.now() - ANNOTATION_STALE_YEARS * 365.25 * 24 * 60 * 60 * 1000;
  let staleCount = 0;
  for (const value of ts) if (value < cutoffMs) staleCount += 1;

  const warnings = [];
  if (rowCount > QUEUE_WARN_ROW_THRESHOLD) {
    warnings.push(`queue length ${rowCount} exceeds ${QUEUE_WARN_ROW_THRESHOLD}-row threshold`);
  }
  if (oldestDate) {
    const age = daysBetween(oldestDate, todayIso());
    if (age != null && age > QUEUE_WARN_AGE_DAYS) {
      warnings.push(`oldest row is ${age} days old (>${QUEUE_WARN_AGE_DAYS}d)`);
    }
  }

  return {
    queuePresent: queueText.length > 0,
    rowCount,
    oldestDate,
    annotationCount: ts.length,
    annotationsOlderThanYears: staleCount,
    warnings,
  };
}

function joinList(items, limit = 12) {
  if (items.length === 0) return "(none)";
  if (items.length <= limit) return items.join(", ");
  return `${items.slice(0, limit).join(", ")}, +${items.length - limit} more`;
}

function renderHeader(quarterlyDueIn) {
  const dueLine =
    quarterlyDueIn <= 0
      ? `**Quarterly hand-check overdue by ${Math.abs(quarterlyDueIn)} days.**`
      : `Quarterly hand-check due in ~${quarterlyDueIn} days.`;
  return [
    `# Curation digest — ${todayIso()}`,
    "",
    "Generated by `npm run digest:curation`. Pharos editorial streams at a glance.",
    "",
    `_${dueLine}_`,
    "",
  ].join("\n");
}

function renderOneLiner(report) {
  const lines = [`## oneLiner coverage`, ""];
  if (report.missing.length === 0) {
    lines.push(`Status: **OK** — ${report.total}/${report.total} active/pre-launch coins have a oneLiner.`);
  } else {
    lines.push(
      `Status: **DRIFT** — ${report.total - report.missing.length}/${report.total} coverage; ${report.missing.length} missing.`,
    );
    lines.push(`Missing: ${joinList(report.missing)}`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderArchetype(report) {
  const lines = [`## mechanismArchetype coverage (${report.segment})`, ""];
  const have = report.tracked - report.missing.length;
  const pct = report.tracked === 0 ? "0.0" : ((have / report.tracked) * 100).toFixed(1);
  lines.push(
    `Tracked non-variant coins in cohort: ${have}/${report.tracked} have an archetype (${pct}%); ${report.variants} variants and ${report.frozen} frozen excluded.`,
  );
  if (report.missing.length > 0) {
    lines.push(`Missing: ${joinList(report.missing)}`);
  }
  if (report.unknown.length > 0) {
    lines.push(
      `Baseline drift: ${report.unknown.length} baseline IDs missing from registry (${joinList(report.unknown)}). Refresh \`scripts/lib/curation-baseline-caps.json\`.`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function renderAttestor(report) {
  const lines = [`## proofOfReserves.attestorTier coverage`, ""];
  const have = report.total - report.missing.length;
  const pct = report.total === 0 ? "0.0" : ((have / report.total) * 100).toFixed(1);
  lines.push(`Independent-audit coins with attestorTier: ${have}/${report.total} (${pct}%).`);
  if (report.missing.length > 0) {
    lines.push(`Missing: ${joinList(report.missing)}`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderSummary(report) {
  const lines = [`## AI summary staleness`, ""];
  lines.push(
    `Stale (>${AI_SUMMARY_STALENESS_DAYS}d since updatedAt) active summaries: ${report.stale.length}. Missing: ${report.missing.length}.`,
  );
  if (report.missing.length > 0) {
    lines.push(`Missing entries: ${joinList(report.missing)}`);
  }
  if (report.stale.length > 0) {
    lines.push("");
    lines.push("Top stale entries:");
    for (const row of report.stale.slice(0, 10)) {
      const tag = row.flag ? ` — ${row.flag}` : "";
      const age = row.ageDays == null ? "n/a" : `${row.ageDays}d`;
      lines.push(`- ${row.id} — last update ${row.lastUpdate} (${age})${tag}`);
    }
    if (report.stale.length > 10) {
      lines.push(`- …and ${report.stale.length - 10} more`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function renderQueueHealth(report) {
  const lines = [`## Annotation queue health`, ""];
  if (!report.queuePresent) {
    lines.push(
      "Queue file `agents/annotation-candidates.md` not present. Run `npm run candidates:annotations` to seed it.",
    );
    lines.push("");
    return lines.join("\n");
  }
  lines.push(`Rows pending review: ${report.rowCount}`);
  lines.push(`Oldest dated row: ${report.oldestDate ?? "(none)"}`);
  lines.push(
    `Curated annotations on file: ${report.annotationCount} total; ${report.annotationsOlderThanYears} are older than ${ANNOTATION_STALE_YEARS} years (quarterly hand-check anchors).`,
  );
  if (report.warnings.length > 0) {
    for (const warn of report.warnings) {
      lines.push(`WARN: ${warn}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function parseExpiryMs(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value * 1000 : Number.NaN;
  if (typeof value === "string") {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : Date.parse(value);
  }
  return Number.NaN;
}

function venueRiskExpiries(entries, horizonMs) {
  return findStaleVenueRiskScoresByEntries(entries, horizonMs).map((stale) => {
    const reviewedMs = Date.parse(`${stale.reviewedAt}T00:00:00Z`);
    const expiryMs = reviewedMs + (VENUE_RISK_SCORE_MAX_AGE_DAYS + 1) * DAY_MS;
    return { id: stale.protocol, expiresAt: new Date(expiryMs).toISOString().slice(0, 10) };
  });
}

export function buildDatedReviewRegistries(horizonMs) {
  return [
    {
      registry: "Chain-maturity reviews (CHAIN_MATURITY_REVIEWS_V1)",
      entries: CHAIN_MATURITY_REVIEWS_V1.map((entry) => ({ id: entry.chainSlug, expiresAt: entry.nextReviewAt })),
    },
    {
      registry: "Stablecoin publication waivers (STABLECOIN_PUBLICATION_WAIVERS)",
      entries: STABLECOIN_PUBLICATION_WAIVERS.map((entry) => ({ id: entry.stablecoinId, expiresAt: entry.expiresAt })),
    },
    {
      registry: "Stablecoin price-gap reviews (STABLECOIN_PRICE_GAP_REVIEWS)",
      entries: STABLECOIN_PRICE_GAP_REVIEWS.map((entry) => ({ id: entry.stablecoinId, expiresAt: entry.expiresAt })),
    },
    {
      registry: "PSI historical price-gap reviews (PSI_HISTORICAL_PRICE_GAP_REVIEWS)",
      entries: PSI_HISTORICAL_PRICE_GAP_REVIEWS.map((entry) => ({ id: entry.stablecoinId, expiresAt: entry.expiresAt })),
    },
    {
      registry: "Market-hours calendar reviews (STABLECOIN_MARKET_HOURS_CALENDARS)",
      entries: STABLECOIN_MARKET_HOURS_CALENDARS.map((entry) => ({ id: entry.calendarId, expiresAt: entry.reviewDeadline })),
    },
    {
      registry: "Supply-integrity value re-baselines (REVIEWED_SUPPLY_VALUE_REBASELINES)",
      entries: REVIEWED_SUPPLY_VALUE_REBASELINES.map((entry) => ({ id: entry.stablecoinId, expiresAt: entry.expiresAt })),
    },
    {
      registry: "Supply-integrity carry reviews (REVIEWED_SUPPLY_CARRIES)",
      entries: REVIEWED_SUPPLY_CARRIES.map((entry) => ({ id: entry.stablecoinId, expiresAt: entry.expiresAt })),
    },
    {
      registry: "Chain-dropout omitted exclusions (REVIEWED_CHAIN_SUPPLY_COLLAPSES)",
      entries: REVIEWED_CHAIN_SUPPLY_COLLAPSES
        .filter((entry) => entry.policy === "exclude-omitted")
        .map((entry) => ({ id: `${entry.assetId}:${entry.chainId}`, expiresAt: entry.excludeOmittedUntil })),
    },
    {
      registry: "Depeg canary no-parity-quote reviews (DEPEG_NO_PARITY_QUOTE_REVIEWS)",
      entries: DEPEG_NO_PARITY_QUOTE_REVIEWS.map((entry) => ({ id: entry.stablecoinId, expiresAt: entry.expiresAt })),
    },
    {
      registry: "Depeg canary blind-event reviews (DEPEG_BLIND_EVENT_REVIEWS)",
      entries: DEPEG_BLIND_EVENT_REVIEWS.map((entry) => ({ id: `${entry.stablecoinId}#${entry.eventId}`, expiresAt: entry.expiresAt })),
    },
    {
      registry: "Reserve-feed reviews (RESERVE_FEED_REVIEWS)",
      entries: RESERVE_FEED_REVIEWS.map((entry) => ({ id: `${entry.stablecoinId}:${entry.adapterKey}`, expiresAt: entry.expiresAt })),
    },
    {
      registry: "Yield venue-risk scores (YIELD_RISK_CONFIG)",
      entries: venueRiskExpiries(YIELD_RISK_CONFIG, horizonMs),
    },
    {
      registry: "Yield dependency-concentration reviews (YIELD_DEPENDENCY_CONCENTRATION)",
      entries: venueRiskExpiries(YIELD_DEPENDENCY_CONCENTRATION, horizonMs),
    },
    {
      registry: "DEX chain-TVL dispositions (REVIEWED_CHAIN_TVL_DISPOSITIONS)",
      entries: REVIEWED_CHAIN_TVL_DISPOSITIONS.map((entry) => ({ id: entry.flag, expiresAt: entry.expiresAt })),
    },
    {
      registry: "DEX anchor-correction review (REVIEWED_POOL_REJECTION_ANCHOR_CORRECTION)",
      entries: [{
        id: REVIEWED_POOL_REJECTION_ANCHOR_CORRECTION.stablecoinId,
        expiresAt: REVIEWED_POOL_REJECTION_ANCHOR_CORRECTION.expiresAt,
      }],
    },
    {
      registry: "DEX coverage waivers (DEX_COVERAGE_WAIVERS)",
      entries: DEX_COVERAGE_WAIVERS.map((entry) => ({ id: `${entry.stablecoinId}:${entry.chain}`, expiresAt: entry.expiresAt })),
    },
    {
      registry: "Yield opportunity exclusions (YIELD_OPPORTUNITY_EXCLUSIONS)",
      entries: YIELD_OPPORTUNITY_EXCLUSIONS.map((entry) => ({
        id: entry.assetSources ? `${entry.projects[0]}:${entry.assetSources.stablecoinId}` : entry.projects.join(","),
        expiresAt: entry.nextReviewAt,
      })),
    },
    {
      registry: "Yield adapter lifecycle reviews (YIELD_ADAPTER_LIFECYCLE)",
      entries: Object.entries(YIELD_ADAPTER_LIFECYCLE)
        .filter(([, entry]) => Boolean(entry.reason?.nextReviewAt))
        .map(([id, entry]) => ({ id, expiresAt: entry.reason.nextReviewAt })),
    },
  ];
}

/**
 * @param {readonly { registry: string; entries: readonly { id: string; expiresAt: string | number | null | undefined }[] }[]} registries
 * @param {number} [nowMs]
 * @param {number} [lookaheadDays]
 */
export function analyzeDatedReviewExpiries(registries, nowMs = Date.now(), lookaheadDays = EXPIRY_LOOKAHEAD_DAYS) {
  const horizonMs = nowMs + lookaheadDays * DAY_MS;
  const horizonDate = new Date(horizonMs).toISOString().slice(0, 10);
  const groups = [];
  let totalEntries = 0;
  let totalExpired = 0;
  let totalInvalid = 0;

  for (const { registry, entries } of registries) {
    const items = [];
    for (const entry of entries) {
      const expiryMs = parseExpiryMs(entry.expiresAt);
      if (!Number.isFinite(expiryMs)) {
        items.push({
          id: entry.id,
          expiryDate: "(invalid)",
          expiryMs: Number.NEGATIVE_INFINITY,
          expired: false,
          invalid: true,
          daysDelta: null,
        });
        totalInvalid += 1;
        continue;
      }
      if (expiryMs > horizonMs) continue;
      const deltaMs = expiryMs - nowMs;
      const expired = deltaMs <= 0;
      const daysDelta = expired
        ? Math.floor(-deltaMs / DAY_MS)
        : Math.ceil(deltaMs / DAY_MS);
      if (expired) totalExpired += 1;
      items.push({
        id: entry.id,
        expiryDate: new Date(expiryMs).toISOString().slice(0, 10),
        expiryMs,
        expired,
        invalid: false,
        daysDelta,
      });
    }
    if (items.length === 0) continue;
    items.sort((a, b) => a.expiryMs - b.expiryMs || a.id.localeCompare(b.id));
    totalEntries += items.length;
    groups.push({ registry, items });
  }

  return {
    lookaheadDays,
    horizonDate,
    totalRegistries: registries.length,
    totalEntries,
    totalExpired,
    totalInvalid,
    groups,
  };
}

/**
 * @param {number} [nowMs]
 * @param {number} [lookaheadDays]
 */
export function collectDatedReviewExpiries(nowMs = Date.now(), lookaheadDays = EXPIRY_LOOKAHEAD_DAYS) {
  const horizonMs = nowMs + lookaheadDays * DAY_MS;
  return analyzeDatedReviewExpiries(buildDatedReviewRegistries(horizonMs), nowMs, lookaheadDays);
}

/**
 * @param {ReturnType<typeof analyzeDatedReviewExpiries>} report
 */
export function renderDatedReviewExpiries(report) {
  const lines = [`## Dated-review expiry lookahead (${report.lookaheadDays}d)`, ""];
  if (report.groups.length === 0) {
    lines.push(
      `Status: **OK** — 0 dated review entries expiring on or before ${report.horizonDate} across ${report.totalRegistries} registries.`,
    );
    lines.push("");
    return lines.join("\n");
  }
  const summaryParts = [
    `${report.totalEntries} ${report.totalEntries === 1 ? "entry" : "entries"} across ${report.groups.length} of ${report.totalRegistries} registries`,
  ];
  if (report.totalExpired > 0) summaryParts.push(`${report.totalExpired} already expired`);
  if (report.totalInvalid > 0) summaryParts.push(`${report.totalInvalid} invalid date`);
  lines.push(`Expiring on or before ${report.horizonDate}: ${summaryParts.join("; ")}.`);
  lines.push("");
  for (const group of report.groups) {
    lines.push(`### ${group.registry}`);
    for (const item of group.items) {
      const statusTag = item.invalid
        ? "invalid date"
        : item.expired
          ? (item.daysDelta === 0 ? "expired today" : `expired ${item.daysDelta}d ago`)
          : `in ${item.daysDelta}d`;
      lines.push(`- ${item.id} — ${item.expiryDate} (${statusTag})`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/** A paused notice reads its own budget before its type's (coin-state.ts). */
function noticeStaleBudget(notice) {
  if (notice.kind === "paused") return { budget: "paused", days: NOTICE_STALE_DAYS.paused };
  if (notice.type === "danger") return { budget: "danger", days: NOTICE_STALE_DAYS.danger };
  if (notice.type === "warning") return { budget: "warning", days: NOTICE_STALE_DAYS.warning };
  return { budget: "info", days: NOTICE_STALE_DAYS.info };
}

const byCoinTitle = (a, b) => a.coinId.localeCompare(b.coinId) || a.title.localeCompare(b.title);

/**
 * Active coin notices due for curation, by UTC calendar day: deadlines
 * already past (the deadline day itself stays actionable), missing or
 * unparseable dates, missing sources, and `asOf` older than the
 * NOTICE_STALE_DAYS budget (history notices are exempt from age only).
 */
export function analyzeNoticeHealth(coins, nowMs = Date.now()) {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const report = { today, totalNotices: 0, expiredDeadlines: [], invalidDates: [], missingSources: [], stale: [] };
  for (const coin of coins) {
    if (status(coin) !== "active" || !Array.isArray(coin.notices)) continue;
    for (const notice of coin.notices) {
      report.totalNotices += 1;
      const row = { coinId: coin.id, title: String(notice?.title ?? "") };
      const asOfValid = isIsoDate(notice?.asOf);
      if (!asOfValid) report.invalidDates.push({ ...row, field: "asOf", value: notice?.asOf ?? null });
      const deadlineRequired = notice?.kind === "deadline";
      const hasDeadline = deadlineRequired || (notice?.kind === "paused" && notice.deadline !== undefined);
      if (hasDeadline && !isIsoDate(notice.deadline)) {
        report.invalidDates.push({ ...row, field: "deadline", value: notice.deadline ?? null });
      } else if (hasDeadline && notice.deadline < today) {
        report.expiredDeadlines.push({ ...row, deadline: notice.deadline, daysAgo: daysBetween(notice.deadline, today) });
      }
      if (!Array.isArray(notice?.sources) || notice.sources.length === 0) report.missingSources.push(row);
      if (!asOfValid || notice.kind === "history") continue;
      const ageDays = daysBetween(notice.asOf, today);
      const { budget, days } = noticeStaleBudget(notice);
      if (ageDays > days) report.stale.push({ ...row, asOf: notice.asOf, ageDays, budget, budgetDays: days });
    }
  }
  report.expiredDeadlines.sort((a, b) => b.daysAgo - a.daysAgo || byCoinTitle(a, b));
  report.invalidDates.sort((a, b) => byCoinTitle(a, b) || a.field.localeCompare(b.field));
  report.missingSources.sort(byCoinTitle);
  report.stale.sort((a, b) => b.ageDays - a.ageDays || byCoinTitle(a, b));
  return report;
}

/**
 * @param {ReturnType<typeof analyzeNoticeHealth>} report
 */
export function renderNoticeHealth(report) {
  const lines = [`## Notice health`, ""];
  const counts = [
    [report.expiredDeadlines.length, "expired deadline"],
    [report.invalidDates.length, "invalid date"],
    [report.missingSources.length, "missing sources"],
    [report.stale.length, "stale"],
  ].filter(([count]) => count > 0);
  if (counts.length === 0) {
    lines.push(`Status: **OK** — ${report.totalNotices} active notices dated, sourced, and within their staleness budgets as of ${report.today}.`);
    lines.push("");
    return lines.join("\n");
  }
  lines.push(`Status: **DRIFT** — ${report.totalNotices} active notices as of ${report.today}: ${counts.map(([count, label]) => `${count} ${label}`).join("; ")}.`);
  lines.push("");
  const label = (row) => `- ${row.coinId} — "${row.title}"`;
  const pushRows = (rows, detail) => {
    for (const row of rows.slice(0, MAX_NOTICE_HEALTH_ROWS)) lines.push(`${label(row)} (${detail(row)})`);
    if (rows.length > MAX_NOTICE_HEALTH_ROWS) lines.push(`- ...and ${rows.length - MAX_NOTICE_HEALTH_ROWS} more`);
  };
  pushRows(report.expiredDeadlines, (row) => `deadline ${row.deadline}, expired ${row.daysAgo}d ago`);
  pushRows(report.invalidDates, (row) => `${row.field} ${row.value == null ? "missing" : `invalid: ${JSON.stringify(row.value)}`}`);
  pushRows(report.missingSources, () => "no sources");
  pushRows(report.stale, (row) => `asOf ${row.asOf}, ${row.ageDays}d > ${row.budgetDays}d ${row.budget} budget`);
  lines.push("");
  return lines.join("\n");
}

function quarterlyDueIn(curatedTimestamps) {
  // Anchor to the digest file's mtime is unreliable across machines; instead
  // we anchor to the most recent date inserted into the curated JSON assets. The
  // hand-check is a calendar reminder — "review top-50-by-mcap coins for
  // annotations older than 24 months every ~90 days".
  const ts = curatedTimestamps;
  if (ts.length === 0) return QUARTERLY_HAND_CHECK_DAYS;
  const latest = Math.max(...ts);
  const elapsed = Math.round((Date.now() - latest) / (1000 * 60 * 60 * 24));
  return QUARTERLY_HAND_CHECK_DAYS - elapsed;
}

function main() {
  const { write } = parseArgs(process.argv.slice(2));

  const coins = readJson(COINS_FILE);
  const summaries = readJson(SUMMARIES_FILE);
  const baseline = readJson(BASELINE_FILE);
  const queueText = readTextOrEmpty(CANDIDATES_FILE);
  const curatedTimestamps = readCuratedAnnotationTimestamps();

  const oneLiner = analyzeOneLiner(coins);
  const archetype = analyzeArchetype(coins, baseline);
  const attestor = analyzeAttestorTier(coins);
  const summary = analyzeSummaryStaleness(coins, summaries);
  const queue = analyzeAnnotationQueue(queueText, curatedTimestamps);
  const expiries = collectDatedReviewExpiries();
  const dueIn = quarterlyDueIn(curatedTimestamps);
  const noticeHealth = analyzeNoticeHealth(coins);

  const out = [
    renderHeader(dueIn),
    renderNoticeHealth(noticeHealth),
    renderOneLiner(oneLiner),
    renderArchetype(archetype),
    renderAttestor(attestor),
    renderSummary(summary),
    renderQueueHealth(queue),
    renderDatedReviewExpiries(expiries),
  ].join("\n");

  process.stdout.write(out);

  if (write) {
    const outPath = resolve(ROOT, `agents/curation-digest-${todayIso()}.md`);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, out, "utf8");
    process.stderr.write(`\nArchived digest to ${outPath}\n`);
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  main();
}
