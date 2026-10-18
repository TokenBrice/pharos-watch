// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { YieldCoinIndex } from "@/components/yield/coin-index";
import { buildStablecoinUrl } from "@shared/lib/urls";

vi.mock("next/link", async () => {
  // Vitest hoists this factory before static imports; load the shared link mock here.
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

// Deliberately no detail loader: index grouping must use only the compact list.
vi.mock("@shared/lib/stablecoins/client-registry", () => ({
  CLIENT_ACTIVE_STABLECOINS: [
    { id: "rebase-test", symbol: "REB", flags: { yieldBearing: true }, yieldType: "rebase" },
    { id: "unknown-test", symbol: "UNKNOWN", flags: { yieldBearing: true } },
    { id: "fixed-test", symbol: "FIXED", flags: { yieldBearing: true }, yieldType: "fixed-yield" },
    { id: "non-yield-test", symbol: "NONE", flags: { yieldBearing: false } },
  ],
}));

describe("YieldCoinIndex", () => {
  it("groups compact taxonomy without sidecars and retains every eligible coin including unclassified entries", () => {
    render(<YieldCoinIndex />);
    expect(screen.getByText(/3 yield-bearing tracked coins/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "REB" }).getAttribute("href")).toBe(buildStablecoinUrl("rebase-test", "yield/"));
    expect(screen.getByRole("link", { name: "FIXED" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "UNKNOWN" }).closest("dl")?.textContent).toContain("Other");
    expect(screen.queryByRole("link", { name: "NONE" })).toBeNull();
  });
});
