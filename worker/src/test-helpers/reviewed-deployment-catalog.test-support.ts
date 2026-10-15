import { vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type * as StablecoinRegistry from "@shared/lib/stablecoins/registry";
import type * as ScoringRegistry from "@shared/lib/stablecoins/safety-score-v9-registry";
import catalog from "./fixtures/reviewed-deployment-catalog-e11c86961.json";

// Accepted-path observations predate the October inventory expansion and the
// JTRSY Solana reclassification. Keep that reviewed input explicit: never invent
// identities or supply for newly discovered deployments to make fixtures pass.
export const REVIEWED_DEPLOYMENT_CATALOG = catalog as unknown as Record<
  string,
  Pick<StablecoinMeta, "contracts" | "bridgeRouteRisk">
>;

vi.mock("@shared/lib/stablecoins/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof StablecoinRegistry>();
  // Mock factories are hoisted before static value imports initialize.
  const { default: snapshot } = await import("./fixtures/reviewed-deployment-catalog-e11c86961.json");
  const reviewed = snapshot as unknown as typeof REVIEWED_DEPLOYMENT_CATALOG;
  const pin = (coins: readonly StablecoinMeta[]) => coins.map((coin) =>
    reviewed[coin.id] ? { ...coin, ...structuredClone(reviewed[coin.id]) } : coin,
  );
  const active = pin(actual.ACTIVE_STABLECOINS);
  const tracked = pin(actual.TRACKED_STABLECOINS);
  const readable = pin(actual.READABLE_STABLECOINS);
  return {
    ...actual,
    ACTIVE_STABLECOINS: active,
    ACTIVE_META_BY_ID: new Map(active.map((coin) => [coin.id, coin])),
    TRACKED_STABLECOINS: tracked,
    TRACKED_META_BY_ID: new Map(tracked.map((coin) => [coin.id, coin])),
    READABLE_STABLECOINS: readable,
    READABLE_META_BY_ID: new Map(readable.map((coin) => [coin.id, coin])),
  };
});

// Both metadata owners must see the same historical fixture objects and map:
// observer tests mutate/spyon that map to exercise inventory expansion.
vi.mock("@shared/lib/stablecoins/safety-score-v9-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof ScoringRegistry>();
  // Hoisted factories must wait until the full-registry fixture mock is installed.
  const registry = await import("@shared/lib/stablecoins/registry");
  return {
    ...actual,
    SAFETY_SCORE_V9_SCORING_ROWS: registry.ACTIVE_STABLECOINS,
    SAFETY_SCORE_V9_ACTIVE_META_BY_ID: registry.ACTIVE_META_BY_ID,
    SAFETY_SCORE_V9_ACTIVE_ASSET_IDS: registry.ACTIVE_STABLECOINS.map((coin) => coin.id),
  };
});
