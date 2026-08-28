import { PUBLIC_DATASET_CURRENT_EXPORTS } from "@/lib/datasets/public-dataset-current";
import { numberValue } from "@shared/lib/type-guards";
import { buildHomepageHeroSnapshot, type HomepageHeroSnapshot } from "@/lib/homepage-hero-snapshot";

interface TopStablecoinsDatasetRow {
  id?: unknown;
  pegType?: unknown;
  circulatingUsd?: unknown;
}

interface TopStablecoinsDataset {
  _meta?: {
    asOfISO?: unknown;
  };
  rows?: TopStablecoinsDatasetRow[];
}

export type { HomepageHeroSnapshot } from "@/lib/homepage-hero-snapshot";

const TOP_STABLECOINS_DATASET = PUBLIC_DATASET_CURRENT_EXPORTS["top-stablecoins"] as TopStablecoinsDataset;

function asOfISO(): string | null {
  const value = TOP_STABLECOINS_DATASET._meta?.asOfISO;
  return typeof value === "string" && value ? value : null;
}

export function getHomepageHeroSnapshot(): HomepageHeroSnapshot {
  const rows = Array.isArray(TOP_STABLECOINS_DATASET.rows) ? TOP_STABLECOINS_DATASET.rows : [];
  return buildHomepageHeroSnapshot(
    rows.flatMap((row) => {
      if (typeof row.id !== "string" || typeof row.pegType !== "string") return [];
      return [{
        id: row.id,
        pegType: row.pegType,
        circulatingUsd: numberValue(row.circulatingUsd) ?? 0,
      }];
    }),
    asOfISO(),
  );
}
