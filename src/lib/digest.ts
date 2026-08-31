/**
 * Editorial typography system for the Digest feature.
 *
 * The digest uses a dual-font "intelligence briefing" aesthetic:
 * - Newsreader (serif) for headlines: refined editorial authority
 * - Courier (monospace italic) for body copy: raw wire-service urgency
 *
 * This pairing creates a distinctive newspaper/terminal hybrid that signals
 * both authority and real-time urgency — core to the Pharos brand personality.
 */

import { formatLongDate, formatShortDate } from "@shared/lib/format";
import type { DigestArchiveEntry, DigestForwardLookOutcome, DigestNextTrigger } from "@shared/types/digest";

/** Inline style for body text — Courier italic for raw intel aesthetic */
export const EDITORIAL_BODY_STYLE: React.CSSProperties = {
  fontFamily: "'Courier New', Courier, monospace",
  fontStyle: "italic",
};

/** Inline style for metadata labels — Courier upright */
export const EDITORIAL_META_STYLE: React.CSSProperties = {
  fontFamily: "'Courier New', Courier, monospace",
};

/**
 * Format a digest date string ("YYYY-MM-DD" or "YYYY-MM-DD-weekly") into a
 * localized label, with the month rendered in the requested style.
 */
export function formatDigestDateLabel(dateStr: string, monthStyle: "long" | "short"): string {
  const parts = dateStr
    .replace(/-weekly$/, "")
    .split("-")
    .map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return dateStr;
  const [year, month, day] = parts;
  const date = new Date(year, month - 1, day);
  if (isNaN(date.getTime())) return dateStr;
  return monthStyle === "long" ? formatLongDate(date) : formatShortDate(date);
}

/**
 * Split digest text into paragraphs by double newlines.
 */
export function splitDigestParagraphs(text: string | null | undefined): string[] {
  if (!text) return [];

  return text
    .split(/\r?\n\s*\r?\n/g)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

export function parseDigestParagraph(paragraph: string): { headerText: string | null; bodyText: string } {
  const headerMatch = paragraph.match(/^\*\*(.+?)\*\*\s*/);
  return {
    headerText: headerMatch?.[1]?.replace(/\.+$/, "") ?? null,
    bodyText: headerMatch ? paragraph.slice(headerMatch[0].length) : paragraph,
  };
}

/**
 * Get body paragraphs from digest data, falling back from extended to basic digest.
 */
export function getDigestBodyParagraphs({
  digest,
  digestExtended,
}: {
  digest: string | null | undefined;
  digestExtended: string | null | undefined;
}): string[] {
  const extendedParagraphs = splitDigestParagraphs(digestExtended);
  if (extendedParagraphs.length > 0) return extendedParagraphs;
  return splitDigestParagraphs(digest);
}

export type DigestTriggerRecordStatus = DigestForwardLookOutcome["status"];
export type DigestTriggerRecordClassKey = DigestNextTrigger["metric"] | "unknown";

export interface DigestTriggerRecordBucket {
  key: DigestTriggerRecordClassKey;
  label: string;
  hit: number;
  missed: number;
  expired: number;
  pending: number;
  total: number;
  resolved: number;
  hitRate: number | null;
}

export interface DigestTriggerRecord {
  total: number;
  hit: number;
  missed: number;
  expired: number;
  pending: number;
  resolved: number;
  hitRate: number | null;
  buckets: readonly DigestTriggerRecordBucket[];
  unclassifiedCount: number;
}

const DIGEST_TRIGGER_METRIC_ORDER: readonly DigestNextTrigger["metric"][] = [
  "depeg-bps",
  "supply-1d-usd",
  "supply-7d-usd",
  "bank-run-gauge",
  "dews-band",
  "psi-score",
  "yield-apy",
  "liquidity-score",
];

const DIGEST_TRIGGER_METRIC_LABELS: Record<DigestNextTrigger["metric"], string> = {
  "depeg-bps": "Depeg width",
  "supply-1d-usd": "Supply velocity (1d)",
  "supply-7d-usd": "Supply velocity (7d)",
  "bank-run-gauge": "Bank Run Gauge",
  "dews-band": "DEWS band",
  "psi-score": "PSI score",
  "yield-apy": "Yield APY",
  "liquidity-score": "Liquidity score",
};

const DIGEST_TRIGGER_CLASS_ALIASES: Record<string, DigestNextTrigger["metric"]> = {
  depeg: "depeg-bps",
  "depeg-bps": "depeg-bps",
  "supply-1d": "supply-1d-usd",
  "supply-1d-usd": "supply-1d-usd",
  "supply-7d": "supply-7d-usd",
  "supply-7d-usd": "supply-7d-usd",
  "bank-run": "bank-run-gauge",
  "bank-run-gauge": "bank-run-gauge",
  dews: "dews-band",
  "dews-band": "dews-band",
  psi: "psi-score",
  "psi-score": "psi-score",
  yield: "yield-apy",
  "yield-apy": "yield-apy",
  liquidity: "liquidity-score",
  "liquidity-score": "liquidity-score",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeDigestTriggerMetric(value: unknown): DigestNextTrigger["metric"] | null {
  if (typeof value !== "string") return null;
  return DIGEST_TRIGGER_CLASS_ALIASES[value] ?? null;
}

function triggerMetricLookup(
  entries: readonly Pick<DigestArchiveEntry, "nextTriggers">[],
): ReadonlyMap<string, DigestNextTrigger["metric"]> {
  const metrics = new Map<string, DigestNextTrigger["metric"]>();
  const conflicts = new Set<string>();
  for (const entry of entries) {
    for (const trigger of entry.nextTriggers ?? []) {
      if (conflicts.has(trigger.id)) continue;
      const previous = metrics.get(trigger.id);
      if (previous && previous !== trigger.metric) {
        metrics.delete(trigger.id);
        conflicts.add(trigger.id);
        continue;
      }
      metrics.set(trigger.id, trigger.metric);
    }
  }
  return metrics;
}

function resolveDigestTriggerMetric(
  outcome: DigestForwardLookOutcome,
  metrics: ReadonlyMap<string, DigestNextTrigger["metric"]>,
): DigestNextTrigger["metric"] | null {
  const rawOutcome: unknown = outcome;
  if (isRecord(rawOutcome)) {
    const explicitMetric = normalizeDigestTriggerMetric(rawOutcome.metric);
    if (explicitMetric) return explicitMetric;
    const explicitClass = normalizeDigestTriggerMetric(rawOutcome.triggerClass);
    if (explicitClass) return explicitClass;
  }
  return metrics.get(outcome.triggerId) ?? null;
}

function emptyTriggerRecordCounts(): Record<DigestTriggerRecordStatus, number> {
  return { hit: 0, missed: 0, expired: 0, pending: 0 };
}

/**
 * Aggregate the forward-look outcomes carried by the public digest archive.
 * The headline deliberately includes expired outcomes in its denominator;
 * pending outcomes remain visible as a separate count. Trigger classes come
 * from the archived trigger metric, and outcomes without one stay explicit in
 * an "Unclassified" bucket rather than being inferred from prose.
 */
export function buildDigestTriggerRecord(
  entries: readonly Pick<DigestArchiveEntry, "nextTriggers" | "forwardLookOutcomes">[],
): DigestTriggerRecord {
  const metrics = triggerMetricLookup(entries);
  const totals = emptyTriggerRecordCounts();
  const bucketCounts = new Map<DigestTriggerRecordClassKey, Record<DigestTriggerRecordStatus, number>>();

  for (const entry of entries) {
    for (const outcome of entry.forwardLookOutcomes ?? []) {
      totals[outcome.status] += 1;
      const key = resolveDigestTriggerMetric(outcome, metrics) ?? "unknown";
      const counts = bucketCounts.get(key) ?? emptyTriggerRecordCounts();
      counts[outcome.status] += 1;
      bucketCounts.set(key, counts);
    }
  }

  const toBucket = (key: DigestTriggerRecordClassKey): DigestTriggerRecordBucket | null => {
    const counts = bucketCounts.get(key);
    if (!counts) return null;
    const total = counts.hit + counts.missed + counts.expired + counts.pending;
    const resolved = counts.hit + counts.missed + counts.expired;
    return {
      key,
      label: key === "unknown" ? "Unclassified" : DIGEST_TRIGGER_METRIC_LABELS[key],
      ...counts,
      total,
      resolved,
      hitRate: resolved > 0 ? counts.hit / resolved : null,
    };
  };

  const buckets = [
    ...DIGEST_TRIGGER_METRIC_ORDER.map(toBucket).filter(
      (bucket): bucket is DigestTriggerRecordBucket => bucket !== null,
    ),
    toBucket("unknown"),
  ].filter((bucket): bucket is DigestTriggerRecordBucket => bucket !== null);
  const resolved = totals.hit + totals.missed + totals.expired;
  const unclassified = bucketCounts.get("unknown") ?? emptyTriggerRecordCounts();

  return {
    total: totals.hit + totals.missed + totals.expired + totals.pending,
    ...totals,
    resolved,
    hitRate: resolved > 0 ? totals.hit / resolved : null,
    buckets,
    unclassifiedCount: unclassified.hit + unclassified.missed + unclassified.expired + unclassified.pending,
  };
}

export function formatDigestTriggerRate(rate: number | null): string {
  return rate == null ? "—" : `${(rate * 100).toFixed(1)}%`;
}
