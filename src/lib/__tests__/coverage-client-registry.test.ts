import { describe, expect, it } from "vitest";

import { CLIENT_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import { coverageFeature as reserveCoverageFeature } from "@/lib/coverage/reserves";

/**
 * Regression guard for the /coverage Reserve View.
 *
 * The slim client registry must carry enough reserve metadata for the
 * coverage matrix to distinguish live / curated-validated / proof reserve
 * states. A previous slimming pass dropped `liveReservesConfig` without a
 * replacement, which silently collapsed every coin to "curated"
 * (score-grade 0/369) because the coin object reached the resolver through
 * an unchecked cast.
 */
describe("coverage reserve resolution from the client registry", () => {
  it("carries the derived liveReserveAdapter for live-enabled coins", () => {
    const withAdapter = CLIENT_ACTIVE_STABLECOINS.filter((coin) => coin.liveReserveAdapter);
    expect(withAdapter.length).toBeGreaterThan(200);
  });

  it("resolves non-curated reserve states for live-enabled client coins", () => {
    const kinds = new Map<string, number>();
    for (const coin of CLIENT_ACTIVE_STABLECOINS) {
      const status = reserveCoverageFeature.resolve(coin, true, true);
      kinds.set(status.kind, (kinds.get(status.kind) ?? 0) + 1);
    }

    // Score-grade live rows must exist when freshness is satisfied.
    expect(kinds.get("live") ?? 0).toBeGreaterThan(50);
    expect(kinds.get("curated-validated") ?? 0).toBeGreaterThan(20);
    expect(kinds.get("proof") ?? 0).toBeGreaterThan(20);
    // The regression collapsed every coin into this bucket.
    expect(kinds.get("curated") ?? 0).toBeLessThan(CLIENT_ACTIVE_STABLECOINS.length / 2);
  });
});
