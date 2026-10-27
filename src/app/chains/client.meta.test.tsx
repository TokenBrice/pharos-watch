// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarborSceneInput } from "@shared/lib/harbor-scene";
import { makeChain } from "@/hooks/__tests__/chain-profile-fixtures";
import { ChainsLeaderboardClient } from "./client";

// No `useChains` mock: the body goes through the real fetch + `_meta` unwrap path (`src/lib/api.ts`), which moves
// the freshness envelope out of `data` into the hook's `meta`.
const { harborInputs } = vi.hoisted(() => ({ harborInputs: [] as HarborSceneInput[] }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/harbor/harbor-hero", () => ({
  HarborHero: ({ data }: { data: HarborSceneInput }) => {
    harborInputs.push(data);
    return null;
  },
}));

afterEach(() => {
  cleanup();
  harborInputs.length = 0;
  vi.unstubAllGlobals();
});

const nowSec = Math.floor(Date.now() / 1000);
const body = {
  chains: [
    makeChain({ healthScore: null, healthBand: null, dominanceShare: 0.5, totalUsd: 500 }),
    makeChain({ id: "tron", name: "Tron", healthScore: null, healthBand: null, dominanceShare: 0.3, totalUsd: 300 }),
  ],
  globalTotalUsd: 1_000,
  chainAttributedTotalUsd: 800,
  unattributedTotalUsd: 200,
  globalChange24hPct: null,
  globalChange7dPct: null,
  globalChange30dPct: null,
  updatedAt: nowSec - 600,
  healthMethodologyVersion: "1.7",
  _meta: {
    updatedAt: nowSec - 600,
    ageSeconds: 600,
    status: "degraded",
    dependencies: { reportCards: { status: "stale", reason: "stale-cache", ageSeconds: 7_200, updatedAt: nowSec - 7_200 } },
  },
};

describe("ChainsLeaderboardClient over the real fetch path", () => {
  it("reads freshness from the hook's meta: true NR reason, current supply stamp and no dependency advisory", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ChainsLeaderboardClient />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByRole("group", { name: "Chain concentration" })).toBeTruthy());

    // Harbor's flag sees the stale report-card dependency, so NR names it instead of a coverage gap
    const reason = "Inputs unavailable: stale-cache";
    expect(screen.getAllByTitle(reason)).toHaveLength(2);
    expect(screen.queryByTitle("Not rated: insufficient Chain Health coverage")).toBeNull();
    expect(screen.getByLabelText("Chain Health not rated").textContent).toContain(`2 chains · ${reason}`);
    expect(harborInputs.at(-1)?._meta?.status).toBe("degraded");

    // only Chain Health inputs lag: the supply stamp stays current (each signal names its own generation)
    expect(screen.queryByText(/^Retained/)).toBeNull();
    expect(screen.getByText(/^as of \d{2}:\d{2} UTC$/)).toBeTruthy();
    // a held dependency over fresh supply is operator signal (ADR-42): NR explains it, no hero chip or body callout
    expect(screen.queryByRole("button", { name: /Stale data|Chain Health inputs/ })).toBeNull();
    expect(screen.queryByText(/Data quality warning/)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
