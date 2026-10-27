// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAIN_META } from "@shared/types/chain-identity";
import { makeChain } from "@/hooks/__tests__/chain-profile-fixtures";
import type { ApiMeta } from "@/lib/api";
import { ChainHero } from "./chain-hero";

vi.mock("next/image", () => ({
  default: ({ alt, src }: { alt: string; src: string }) => <img alt={alt} src={src} />,
}));
vi.mock("@/components/methodology-hint", () => ({
  MethodologyCardActions: () => null,
  MethodologyHint: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MethodologyLabel: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const generation = Date.UTC(2026, 9, 26) / 1000;
const receivedAt = generation * 1000;
const heldMeta: ApiMeta = {
  updatedAt: generation, ageSeconds: 0, status: "degraded", freshBudgetSec: 1_800, degradedBudgetSec: 3_600,
  dependencies: { reportCards: { status: "stale", reason: "stale-cache", ageSeconds: 7_200 } },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(receivedAt);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ChainHero freshness", () => {
  it("keeps NR under a held dependency quiet, then ages the original supply generation into the stale chip", async () => {
    render(<ChainHero
      meta={CHAIN_META.ethereum}
      chain={makeChain({ healthScore: null, healthBand: null, healthFactors: { ...makeChain().healthFactors, quality: null } })}
      apiMeta={heldMeta}
      dataUpdatedAt={receivedAt}
    />);
    await act(async () => { vi.advanceTimersByTime(0); });
    expect(screen.queryByRole("button", { name: /Stale data|Chain Health inputs/ })).toBeNull();
    expect(document.body.textContent).toContain("report-card inputs are stale");

    await act(async () => { vi.advanceTimersByTime(3_600_000); });
    expect(screen.queryByRole("button", { name: /Stale data/ })).toBeNull();
    await act(async () => { vi.advanceTimersByTime(1); });
    fireEvent.click(screen.getByRole("button", { name: /Stale data/ }));
    expect(document.body.textContent).toContain("Supply snapshot as of 2026-10-26 00:00 UTC, 1h old; stale after 1h.");
    expect(document.body.textContent).not.toContain("Chain Health inputs");
  });
});
