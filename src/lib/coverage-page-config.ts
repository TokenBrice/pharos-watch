import {
  Activity,
  ArrowUpDown,
  Droplets,
  Landmark,
  LifeBuoy,
  Network,
  ShieldBan,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";
import type { CoverageFeatureKey } from "@/lib/coverage";

export type CoverageFilterKey =
  | "all"
  | "live-reserves"
  | "yield"
  | "flows"
  | "blacklist";

export type CoverageSortKey = "market-cap" | "name" | "most-covered";

export const FEATURE_ICON: Record<CoverageFeatureKey, typeof Activity> = {
  price: Activity,
  safety: ShieldCheck,
  dex: Droplets,
  reserves: Landmark,
  redemption: LifeBuoy,
  yield: TrendingUp,
  flows: ArrowUpDown,
  blacklist: ShieldBan,
  dependency: Network,
};

export const FEATURE_ACCENT_CLASSES: Record<
  CoverageFeatureKey,
  {
    rail: string;
    ring: string;
    icon: string;
    countBar: string;
    chip: string;
    tile: string;
    title: string;
  }
> = {
  price: {
    rail: "before:bg-sky-400/70",
    ring: "border-sky-500/28 bg-sky-500/10",
    icon: "text-sky-700 dark:text-sky-300",
    countBar: "bg-sky-400/80",
    chip: "border-sky-500/24 bg-sky-500/10 text-sky-800 dark:text-sky-200",
    tile: "border-sky-500/18 bg-sky-500/6",
    title: "text-sky-800 dark:text-sky-100",
  },
  safety: {
    rail: "before:bg-emerald-400/70",
    ring: "border-emerald-500/28 bg-emerald-500/10",
    icon: "text-emerald-700 dark:text-emerald-300",
    countBar: "bg-emerald-400/80",
    chip: "border-emerald-500/24 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
    tile: "border-emerald-500/18 bg-emerald-500/6",
    title: "text-emerald-800 dark:text-emerald-100",
  },
  dex: {
    rail: "before:bg-cyan-400/70",
    ring: "border-cyan-500/28 bg-cyan-500/10",
    icon: "text-cyan-700 dark:text-cyan-300",
    countBar: "bg-cyan-400/80",
    chip: "border-cyan-500/24 bg-cyan-500/10 text-cyan-800 dark:text-cyan-200",
    tile: "border-cyan-500/18 bg-cyan-500/6",
    title: "text-cyan-800 dark:text-cyan-100",
  },
  reserves: {
    rail: "before:bg-amber-400/75",
    ring: "border-amber-500/30 bg-amber-500/10",
    icon: "text-amber-700 dark:text-amber-300",
    countBar: "bg-amber-400/85",
    chip: "border-amber-500/28 bg-amber-500/12 text-amber-800 dark:text-amber-200",
    tile: "border-amber-500/18 bg-amber-500/6",
    title: "text-amber-800 dark:text-amber-100",
  },
  redemption: {
    rail: "before:bg-rose-400/75",
    ring: "border-rose-500/28 bg-rose-500/10",
    icon: "text-rose-700 dark:text-rose-300",
    countBar: "bg-rose-400/85",
    chip: "border-rose-500/24 bg-rose-500/10 text-rose-800 dark:text-rose-200",
    tile: "border-rose-500/18 bg-rose-500/6",
    title: "text-rose-800 dark:text-rose-100",
  },
  yield: {
    rail: "before:bg-teal-400/75",
    ring: "border-teal-500/28 bg-teal-500/10",
    icon: "text-teal-700 dark:text-teal-300",
    countBar: "bg-teal-400/85",
    chip: "border-teal-500/24 bg-teal-500/10 text-teal-800 dark:text-teal-200",
    tile: "border-teal-500/18 bg-teal-500/6",
    title: "text-teal-800 dark:text-teal-100",
  },
  flows: {
    rail: "before:bg-indigo-400/75",
    ring: "border-indigo-500/28 bg-indigo-500/10",
    icon: "text-indigo-700 dark:text-indigo-300",
    countBar: "bg-indigo-400/85",
    chip: "border-indigo-500/24 bg-indigo-500/10 text-indigo-800 dark:text-indigo-200",
    tile: "border-indigo-500/18 bg-indigo-500/6",
    title: "text-indigo-800 dark:text-indigo-100",
  },
  blacklist: {
    rail: "before:bg-orange-400/75",
    ring: "border-orange-500/30 bg-orange-500/10",
    icon: "text-orange-700 dark:text-orange-300",
    countBar: "bg-orange-400/85",
    chip: "border-orange-500/28 bg-orange-500/12 text-orange-800 dark:text-orange-200",
    tile: "border-orange-500/18 bg-orange-500/6",
    title: "text-orange-800 dark:text-orange-100",
  },
  dependency: {
    rail: "before:bg-frost-blue/75",
    ring: "border-frost-blue/28 bg-frost-blue/10",
    icon: "text-frost-blue",
    countBar: "bg-frost-blue/85",
    chip: "border-frost-blue/24 bg-frost-blue/10 text-sky-800 dark:text-sky-200",
    tile: "border-frost-blue/18 bg-frost-blue/6",
    title: "text-sky-800 dark:text-sky-100",
  },
};

export const FILTER_OPTIONS: ReadonlyArray<{
  key: CoverageFilterKey;
  label: string;
}> = [
  { key: "all", label: "All coins" },
  { key: "live-reserves", label: "Live reserves" },
  { key: "yield", label: "Yield" },
  { key: "flows", label: "Flows" },
  { key: "blacklist", label: "Blacklist" },
] as const;

export const MOBILE_PREVIEW_FEATURES: readonly CoverageFeatureKey[] = [
  "price",
  "dex",
  "reserves",
  "flows",
] as const;

export const LEGEND_ITEMS = [
  {
    term: "NR",
    description: "No current rating or observed row is available for that surface.",
  },
  {
    term: "—",
    description: "Pharos does not currently expose that feature for the asset.",
  },
  {
    term: "Bootstr.",
    description: "Tracking is configured, but the history window is still building.",
  },
  {
    term: "Price only",
    description: "NAV-priced asset with price coverage, but no peg or depeg tracking.",
  },
] as const;
