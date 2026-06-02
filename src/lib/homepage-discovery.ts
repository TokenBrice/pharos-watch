import type { LucideIcon } from "lucide-react";

import {
  BOTTOM_NAV_ITEMS,
  NAV_GROUPS,
  PRIMARY_NAV_ITEMS,
  type NavItem,
} from "@/lib/nav-config";
import { readJsonStorageValue, writeJsonStorageValue } from "@/lib/browser-storage";

export interface HomepageDiscoverySuggestion {
  title: string;
  description: string;
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

const GROUP_ACCENTS: Record<string, string> = {
  CORE: "var(--brand-accent)",
  TRACK: "var(--p-teal-500)",
  ANALYZE: "var(--p-purple-500)",
  MONITOR: "var(--p-amber-500)",
  LEARN: "var(--p-green-500)",
  REFERENCE: "var(--p-blue-500)",
  GUIDE: "var(--p-pink-500)",
};

function toDiscoverySuggestion(item: NavItem, groupLabel: string): HomepageDiscoverySuggestion {
  return {
    title: item.label,
    description: item.description ?? "Open this Pharos surface.",
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
  ...NAV_GROUPS.flatMap((group) =>
    group.items
      .filter((item) => !item.external)
      .map((item) => toDiscoverySuggestion(item, group.label)),
  ),
  ...BOTTOM_NAV_ITEMS
    .filter((item) => !item.external)
    .map((item) => toDiscoverySuggestion(item, "GUIDE")),
];

export const HOMEPAGE_DISCOVERY_ROTATION_POOL: readonly HomepageDiscoverySuggestion[] =
  interleaveDiscoverySuggestions(HOMEPAGE_DISCOVERY_POOL);

export function getHomepageDiscoveryCycleLength(
  poolLength = HOMEPAGE_DISCOVERY_ROTATION_POOL.length,
  visibleCount = HOMEPAGE_DISCOVERY_VISIBLE_COUNT,
): number {
  if (poolLength <= 0 || visibleCount <= 0) return 1;
  return Math.max(1, Math.ceil(poolLength / visibleCount));
}

function positiveModulo(value: number, modulus: number): number {
  if (modulus <= 0) return 0;
  return ((value % modulus) + modulus) % modulus;
}

export function selectHomepageDiscoverySuggestions(
  pool: readonly HomepageDiscoverySuggestion[] = HOMEPAGE_DISCOVERY_ROTATION_POOL,
  visitIndex = 0,
  visibleCount = HOMEPAGE_DISCOVERY_VISIBLE_COUNT,
): HomepageDiscoverySuggestion[] {
  if (pool.length === 0 || visibleCount <= 0) return [];
  if (pool.length <= visibleCount) return [...pool];

  const cycleLength = getHomepageDiscoveryCycleLength(pool.length, visibleCount);
  const start = positiveModulo(visitIndex, cycleLength) * visibleCount;
  const selected: HomepageDiscoverySuggestion[] = [];

  for (let offset = 0; offset < visibleCount; offset += 1) {
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

export function advanceHomepageDiscoveryRotation(
  storage: Storage | null | undefined,
  cycleLength = getHomepageDiscoveryCycleLength(),
): number {
  if (!storage) return 0;

  const safeCycleLength = Math.max(1, Math.floor(cycleLength));
  const current = readHomepageDiscoveryRotationState(storage);
  const cursor = positiveModulo(current.cursor, safeCycleLength);

  writeJsonStorageValue(storage, HOMEPAGE_DISCOVERY_STORAGE_KEY, {
    cursor: (cursor + 1) % safeCycleLength,
  });

  return cursor;
}
