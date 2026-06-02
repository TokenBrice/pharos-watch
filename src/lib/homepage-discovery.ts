import type { LucideIcon } from "lucide-react";

import {
  NAV_GROUPS,
  PRIMARY_NAV_ITEMS,
  type NavItem,
} from "@/lib/nav-config";
import { readJsonStorageValue, writeJsonStorageValue } from "@/lib/browser-storage";

export interface HomepageDiscoverySuggestion {
  title: string;
  description: string;
  shortDescription: string;
  href: string;
  groupLabel: string;
  accent: string;
  icon: LucideIcon;
}

export interface HomepageDiscoveryRotationState {
  cursor: number;
}

const HOMEPAGE_DISCOVERY_VISIBLE_COUNT = 5;
export const HOMEPAGE_DISCOVERY_STORAGE_KEY = "pharos.homepageDiscovery.v1";

const DEFAULT_ROTATION_STATE: HomepageDiscoveryRotationState = { cursor: 0 };
const DISCOVERY_NAV_GROUP_KEYS = new Set(["data", "tools", "monitor"]);

const GROUP_ACCENTS: Record<string, string> = {
  CORE: "var(--brand-accent)",
  TRACK: "var(--p-teal-500)",
  ANALYZE: "var(--p-purple-500)",
  MONITOR: "var(--p-amber-500)",
  LEARN: "var(--p-green-500)",
  REFERENCE: "var(--p-blue-500)",
  GUIDE: "var(--p-pink-500)",
};

const SHORT_DESCRIPTIONS: Record<string, string> = {
  "/safety-scores/": "Report cards",
  "/depeg/": "Peg + DDR",
  "/yield/": "Risk yields",
  "/alt-pegs/": "Alt-peg cohorts",
  "/freezewatch/": "Freeze risk",
  "/stability-index/": "PSI regime",
  "/pharoswatchbot/": "Telegram peg alerts",
  "/liquidity/": "DEX scores",
  "/flows/": "Mint/burns",
  "/chains/": "Chain mix",
  "/cemetery/": "Failures",
  "/screener/": "Filter coins",
  "/dependency-map/": "Risk graph",
  "/portfolio/": "Portfolio risk",
  "/compare/": "Peer compare",
  "/timeline/": "Live event tape",
  "/compliance/": "Policy status",
  "/upcoming/": "Launch watchlist",
  "/digest/": "Daily brief",
  "/status/": "Pipeline health",
};

function toDiscoverySuggestion(item: NavItem, groupLabel: string): HomepageDiscoverySuggestion {
  return {
    title: item.label,
    description: item.description ?? "Open this Pharos surface.",
    shortDescription: SHORT_DESCRIPTIONS[item.href] ?? item.description ?? "Open this surface",
    href: item.href,
    groupLabel,
    accent: GROUP_ACCENTS[groupLabel] ?? "var(--brand-accent)",
    icon: item.icon,
  };
}

function dedupeDiscoverySuggestions(
  suggestions: readonly HomepageDiscoverySuggestion[],
): HomepageDiscoverySuggestion[] {
  const seen = new Set<string>();
  const deduped: HomepageDiscoverySuggestion[] = [];

  for (const suggestion of suggestions) {
    if (seen.has(suggestion.href)) continue;
    seen.add(suggestion.href);
    deduped.push(suggestion);
  }

  return deduped;
}

export function interleaveDiscoverySuggestions(
  suggestions: readonly HomepageDiscoverySuggestion[],
): HomepageDiscoverySuggestion[] {
  const deduped = dedupeDiscoverySuggestions(suggestions);
  const groupOrder: string[] = [];
  const grouped = new Map<string, HomepageDiscoverySuggestion[]>();

  for (const suggestion of deduped) {
    const bucket = grouped.get(suggestion.groupLabel);
    if (bucket) {
      bucket.push(suggestion);
      continue;
    }

    groupOrder.push(suggestion.groupLabel);
    grouped.set(suggestion.groupLabel, [suggestion]);
  }

  const longestGroup = Math.max(0, ...Array.from(grouped.values(), (bucket) => bucket.length));
  const interleaved: HomepageDiscoverySuggestion[] = [];

  for (let index = 0; index < longestGroup; index += 1) {
    for (const groupLabel of groupOrder) {
      const suggestion = grouped.get(groupLabel)?.[index];
      if (suggestion) interleaved.push(suggestion);
    }
  }

  return interleaved;
}

export const HOMEPAGE_DISCOVERY_POOL: readonly HomepageDiscoverySuggestion[] = [
  ...PRIMARY_NAV_ITEMS
    .filter((item) => item.href !== "/" && !item.external)
    .map((item) => toDiscoverySuggestion(item, "CORE")),
  ...NAV_GROUPS.filter((group) => DISCOVERY_NAV_GROUP_KEYS.has(group.key)).flatMap((group) =>
    group.items
      .filter((item) => !item.external)
      .map((item) => toDiscoverySuggestion(item, group.label)),
  ),
];

export const HOMEPAGE_DISCOVERY_ROTATION_POOL: readonly HomepageDiscoverySuggestion[] =
  interleaveDiscoverySuggestions(HOMEPAGE_DISCOVERY_POOL);

export function getHomepageDiscoveryCycleLength(
  poolLength = HOMEPAGE_DISCOVERY_ROTATION_POOL.length,
  _visibleCount = HOMEPAGE_DISCOVERY_VISIBLE_COUNT,
): number {
  if (poolLength <= 0) return 1;
  return Math.max(1, Math.floor(poolLength));
}

function positiveModulo(value: number, modulus: number): number {
  if (modulus <= 0) return 0;
  return ((value % modulus) + modulus) % modulus;
}

export function selectHomepageDiscoverySuggestions(
  pool: readonly HomepageDiscoverySuggestion[] = HOMEPAGE_DISCOVERY_ROTATION_POOL,
  spotlightIndex = 0,
  visibleCount = HOMEPAGE_DISCOVERY_VISIBLE_COUNT,
): HomepageDiscoverySuggestion[] {
  if (pool.length === 0 || visibleCount <= 0) return [];

  const start = positiveModulo(spotlightIndex, pool.length);
  const count = Math.min(pool.length, visibleCount);
  const selected: HomepageDiscoverySuggestion[] = [];

  for (let offset = 0; offset < count; offset += 1) {
    selected.push(pool[(start + offset) % pool.length]);
  }

  return selected;
}

export function normalizeHomepageDiscoveryRotationState(
  value: unknown,
): HomepageDiscoveryRotationState {
  if (!value || typeof value !== "object") return DEFAULT_ROTATION_STATE;

  const candidate = value as Partial<HomepageDiscoveryRotationState>;
  return {
    cursor:
      typeof candidate.cursor === "number" && Number.isFinite(candidate.cursor)
        ? Math.max(0, Math.floor(candidate.cursor))
        : 0,
  };
}

function readHomepageDiscoveryRotationState(
  storage: Storage | null | undefined,
): HomepageDiscoveryRotationState {
  return readJsonStorageValue(
    storage,
    HOMEPAGE_DISCOVERY_STORAGE_KEY,
    normalizeHomepageDiscoveryRotationState,
    DEFAULT_ROTATION_STATE,
  );
}

function chooseHomepageDiscoveryCursor(
  cycleLength: number,
  previousCursor: number,
  random: () => number,
): number {
  const safeCycleLength = Math.max(1, Math.floor(cycleLength));
  if (safeCycleLength <= 1) return 0;

  const value = random();
  const normalizedRandom = Number.isFinite(value)
    ? Math.min(0.999999999, Math.max(0, value))
    : 0;
  const previous = positiveModulo(previousCursor, safeCycleLength);
  const candidate = Math.floor(normalizedRandom * safeCycleLength);

  return candidate === previous ? (candidate + 1) % safeCycleLength : candidate;
}

export function advanceHomepageDiscoveryRotation(
  storage: Storage | null | undefined,
  cycleLength = getHomepageDiscoveryCycleLength(),
  random: () => number = Math.random,
): number {
  const safeCycleLength = Math.max(1, Math.floor(cycleLength));
  const current = storage
    ? readHomepageDiscoveryRotationState(storage)
    : DEFAULT_ROTATION_STATE;
  const cursor = chooseHomepageDiscoveryCursor(safeCycleLength, current.cursor, random);

  if (!storage) return cursor;

  writeJsonStorageValue(storage, HOMEPAGE_DISCOVERY_STORAGE_KEY, {
    cursor,
  });

  return cursor;
}
