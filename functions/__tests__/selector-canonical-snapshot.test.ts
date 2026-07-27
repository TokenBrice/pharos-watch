import { describe, expect, it, vi } from "vitest";
import type { SelectorInput } from "@shared/lib/selector/types";
import { recomputeVerifiedSelectorSnapshot } from "../lib/selector-canonical-snapshot";

const input = {
  profile: "treasury",
  pegCurrency: "USD",
  horizon: "6mplus",
  depegTolerance: "zero",
  composability: "none",
  exitSpeed: "any",
  venuePreferences: ["custody"],
  minApy: null,
  yieldNativeOnly: false,
  decentralization: "any",
  custodyOk: "any",
} satisfies SelectorInput;

describe("canonical selector snapshot recomputation", () => {
  it("fails closed without minting a verified snapshot from the retired V8 model", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      recomputeVerifiedSelectorSnapshot(
        input,
        new Request("https://pharos.watch/selector-snapshot", { method: "POST" }),
        {
          SITE_API_ORIGIN: "https://site-api.pharos.watch",
          SITE_API_SHARED_SECRET: "test-secret",
        },
      ),
    ).rejects.toThrow("V9 selector recommendation policy is not available");

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
