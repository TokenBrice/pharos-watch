import Link from "next/link";
import { formatDeviationBps, formatIsoDate } from "@shared/lib/format";
import { CLIENT_TRACKED_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import depegEventRelatedData from "@/generated/depeg-event-related-data.json";
import type { DepegEventSearchEntry } from "@shared/types/market";

const ARCHETYPE_BY_COIN = new Map(
  CLIENT_TRACKED_STABLECOINS.map((coin) => [coin.id, coin.mechanismArchetype] as const),
);

export interface RelatedIncidentsRailProps {
  /** Slug of the event to exclude from the listing (typically the current event). */
  excludeEventId?: string;
  /** Peg currency of the focal event — drives the "same peg currency" group. */
  pegCurrency?: string;
  /** Mechanism archetype of the focal event's coin — drives the "same risk archetype" group. */
  riskArchetype?: string;
  /** Unix-seconds timestamp of the focal event — drives the "DEWS context" group. */
  startedAt?: number;
  className?: string;
}

const MAX_TOTAL_ITEMS = 5;
const MAX_PER_GROUP = 3;
const DEWS_CONTEXT_WINDOW_SEC = 7 * 24 * 60 * 60; // ±7 days

interface RelatedItem {
  slug: string;
  symbol: string;
  startedAt: number;
  peakDeviationBps: number;
  direction: "above" | "below";
}

interface RelatedGroup {
  label: string;
  items: RelatedItem[];
}

const RELATED_DEPEG_EVENTS = depegEventRelatedData as readonly DepegEventSearchEntry[];

function toRelatedItem(event: DepegEventSearchEntry): RelatedItem {
  return {
    slug: event.slug,
    symbol: event.symbol,
    startedAt: event.startedAt,
    peakDeviationBps: event.peakDeviationBps,
    direction: event.direction,
  };
}

function sortNewest<T extends { startedAt: number; slug: string }>(events: readonly T[]): T[] {
  return [...events].sort((a, b) => {
    if (b.startedAt !== a.startedAt) return b.startedAt - a.startedAt;
    return a.slug.localeCompare(b.slug);
  });
}

function selectGroups({
  excludeEventId,
  pegCurrency,
  riskArchetype,
  startedAt,
}: Pick<
  RelatedIncidentsRailProps,
  "excludeEventId" | "pegCurrency" | "riskArchetype" | "startedAt"
>): RelatedGroup[] {
  const pool = RELATED_DEPEG_EVENTS.filter((event) => event.slug !== excludeEventId);
  const used = new Set<string>();
  const groups: RelatedGroup[] = [];

  // 1. Same peg currency
  if (pegCurrency) {
    const cohort = pool.filter((event) => event.pegType === pegCurrency);
    const items = sortNewest(cohort)
      .filter((event) => !used.has(event.slug))
      .slice(0, MAX_PER_GROUP);
    if (items.length > 0) {
      items.forEach((event) => used.add(event.slug));
      groups.push({
        label: `Other recent ${pegCurrency} depegs`,
        items: items.map(toRelatedItem),
      });
    }
  }

  // 2. Same risk archetype (looked up via the coin's mechanism archetype)
  if (riskArchetype) {
    const cohort = pool.filter(
      (event) => ARCHETYPE_BY_COIN.get(event.stablecoinId) === riskArchetype,
    );
    const items = sortNewest(cohort)
      .filter((event) => !used.has(event.slug))
      .slice(0, MAX_PER_GROUP);
    if (items.length > 0) {
      items.forEach((event) => used.add(event.slug));
      groups.push({
        label: `Other ${riskArchetype} incidents`,
        items: items.map(toRelatedItem),
      });
    }
  }

  // 3. DEWS context at timestamp — other coins with depegs in a ±7-day window.
  // We do not consume live DEWS history here (Workers-only); the timestamp
  // cohort approximates "other stablecoins under stress at the same moment."
  if (startedAt) {
    const cohort = pool.filter(
      (event) => Math.abs(event.startedAt - startedAt) <= DEWS_CONTEXT_WINDOW_SEC,
    );
    const items = sortNewest(cohort)
      .filter((event) => !used.has(event.slug))
      .slice(0, 2);
    if (items.length > 0) {
      items.forEach((event) => used.add(event.slug));
      groups.push({
        label: "Co-occurring stress events",
        items: items.map(toRelatedItem),
      });
    }
  }

  // Enforce the 5-total cap across groups, oldest-priority trimmed.
  let remaining = MAX_TOTAL_ITEMS;
  const trimmed: RelatedGroup[] = [];
  for (const group of groups) {
    if (remaining <= 0) break;
    const take = group.items.slice(0, remaining);
    if (take.length === 0) continue;
    trimmed.push({ label: group.label, items: take });
    remaining -= take.length;
  }
  return trimmed;
}

export function RelatedIncidentsRail({
  excludeEventId,
  pegCurrency,
  riskArchetype,
  startedAt,
  className,
}: RelatedIncidentsRailProps) {
  const groups = selectGroups({ excludeEventId, pegCurrency, riskArchetype, startedAt });
  if (groups.length === 0) return null;

  return (
    <section
      aria-label="Related incidents"
      className={`space-y-3 border-t border-border/50 pt-4 ${className ?? ""}`}
    >
      <p className="pharos-kicker">Related incidents</p>
      <div className="space-y-4">
        {groups.map((group) => (
          <div key={group.label} className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">{group.label}</p>
            <ul className="space-y-1">
              {group.items.map((item) => (
                <li key={item.slug}>
                  <Link
                    href={`/depeg/${item.slug}/`}
                    className="pharos-focus-ring group flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm transition-colors hover:text-foreground"
                  >
                    <span className="font-mono text-xs tabular-nums text-muted-foreground">
                      {formatIsoDate(item.startedAt)}
                    </span>
                    <span className="font-medium text-foreground/90 group-hover:text-foreground">
                      {item.symbol}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      peak {formatDeviationBps(item.peakDeviationBps)} {item.direction === "below" ? "below" : "above"} peg
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
