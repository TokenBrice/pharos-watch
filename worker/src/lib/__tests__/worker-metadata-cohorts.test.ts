import { describe, expect, it } from "vitest";
import { CORE_AGGREGATE_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/aggregate-registry";
import { YIELD_BEARING_STABLECOINS } from "@shared/lib/tracked-stablecoin-utils";
import { WORKER_CORE_AGGREGATE_ACTIVE_STABLECOINS, WORKER_YIELD_BEARING_STABLECOINS } from "../worker-metadata-cohorts";

describe("heavy-owned projected metadata cohorts", () => {
  it("preserves aggregate chart membership and order without narrowing the shared owner", () => {
    expect(WORKER_CORE_AGGREGATE_ACTIVE_STABLECOINS.map((coin) => coin.id))
      .toEqual(CORE_AGGREGATE_ACTIVE_STABLECOINS.map((coin) => coin.id));
  });

  it("preserves active and pre-launch yield configuration membership and NAV flags", () => {
    const project = (rows: readonly { id: string; flags: { navToken?: boolean } }[]) =>
      rows.map((coin) => [coin.id, coin.flags.navToken]);
    expect(project(WORKER_YIELD_BEARING_STABLECOINS)).toEqual(project(YIELD_BEARING_STABLECOINS));
  });
});
