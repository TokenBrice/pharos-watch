// Canonical human labels + badge styles for yield `dataSource` keys.
// Shared by the yield detail section and the yield source board so the two
// surfaces cannot drift (they previously disagreed on `defillama-auto` and
// `protocol-api`). Badge strings are static Tailwind class strings.

export interface YieldDataSourceMeta {
  label: string;
  badge: string;
}

const YIELD_DATA_SOURCE_META: Record<string, YieldDataSourceMeta> = {
  onchain: {
    label: "On-chain",
    badge: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
  },
  defillama: {
    label: "DeFiLlama",
    badge: "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/20",
  },
  "defillama-auto": {
    label: "DeFiLlama auto",
    badge: "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/20",
  },
  "protocol-api": {
    label: "Protocol API",
    badge: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-400 border-cyan-500/20",
  },
  "price-derived": {
    label: "Price-derived",
    badge: "bg-violet-500/10 text-violet-700 dark:text-violet-400 border-violet-500/20",
  },
  "rate-derived": {
    label: "Rate-derived",
    badge: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-400 border-cyan-500/20",
  },
};

function getKnownYieldDataSourceMeta(dataSource: string): YieldDataSourceMeta | null {
  return Object.prototype.hasOwnProperty.call(YIELD_DATA_SOURCE_META, dataSource)
    ? YIELD_DATA_SOURCE_META[dataSource]
    : null;
}

function titleizeYieldDataSourceKey(dataSource: string): string {
  return (
    dataSource
      .split(/[-_\s]+/u)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || "Unknown"
  );
}

// Unknown keys are free-form `z.string()` values; rendering them with the
// DeFiLlama badge asserted a provenance that was never published (E24).
const UNKNOWN_YIELD_DATA_SOURCE_BADGE = "border-border/60 bg-muted/30 text-muted-foreground";

export function getYieldDataSourceMeta(dataSource: string): YieldDataSourceMeta {
  const known = getKnownYieldDataSourceMeta(dataSource);
  if (known) return known;
  return { label: titleizeYieldDataSourceKey(dataSource), badge: UNKNOWN_YIELD_DATA_SOURCE_BADGE };
}

export function getYieldDataSourceLabel(dataSource: string): string {
  const known = getKnownYieldDataSourceMeta(dataSource);
  if (known) return known.label;
  return titleizeYieldDataSourceKey(dataSource);
}
