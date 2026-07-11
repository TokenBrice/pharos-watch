import { describe, expect, it } from "vitest";
import {
  ACTIVE_STABLECOINS,
  FROZEN_STABLECOINS,
  PRE_LAUNCH_STABLECOINS,
} from "@shared/lib/stablecoins/registry";
import {
  assertSubscribableCoin,
  isSubscribableCoin,
} from "../telegram-subscription-eligibility";

describe("Telegram subscription eligibility", () => {
  it("allows active and pre-launch assets but rejects frozen and unknown ids", () => {
    const active = ACTIVE_STABLECOINS[0];
    const preLaunch = PRE_LAUNCH_STABLECOINS[0];
    const frozen = FROZEN_STABLECOINS[0];
    if (!active || !preLaunch || !frozen) throw new Error("Expected lifecycle fixtures");

    expect(isSubscribableCoin(active.id)).toBe(true);
    expect(isSubscribableCoin(preLaunch.id)).toBe(true);
    expect(isSubscribableCoin(frozen.id)).toBe(false);
    expect(isSubscribableCoin("not-a-coin")).toBe(false);
    expect(() => assertSubscribableCoin(frozen.id)).toThrow(/not subscribable/i);
  });
});
