import { describe, expect, it, vi } from "vitest";

vi.mock("@shared/lib/stablecoins/worker-runtime-registry", () => {
  const coins = ["active", "pre-launch", "frozen", "quarantined", "delisted"]
    .map((status) => ({ id: status, status }));
  return {
    WORKER_TRACKED_STABLECOINS: coins,
    WORKER_TRACKED_META_BY_ID: new Map(coins.map((coin) => [coin.id, coin])),
  };
});
import {
  assertSubscribableCoin,
  isSubscribableCoin,
} from "../telegram/subscription-eligibility";

describe("Telegram subscription eligibility", () => {
  it("allows active and pre-launch assets but rejects every inactive post-launch state", () => {
    expect(isSubscribableCoin("active")).toBe(true);
    expect(isSubscribableCoin("pre-launch")).toBe(true);
    expect(isSubscribableCoin("frozen")).toBe(false);
    expect(isSubscribableCoin("quarantined")).toBe(false);
    expect(isSubscribableCoin("delisted")).toBe(false);
    expect(isSubscribableCoin("not-a-coin")).toBe(false);
    expect(() => assertSubscribableCoin("frozen")).toThrow(RangeError);
  });
});
