// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DetailEvidenceProvider, useDetailEvidence } from "@/lib/detail-evidence";
import type { DetailEvidence } from "@/lib/detail-evidence-selection";
import { isDetailSnapshotQuery, seedStablecoinDetailQueryCache } from "@/lib/api";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";
import { DETAIL_EVIDENCE_TEST_NOW as now, makeDetailEvidence } from "@/test/fixtures/detail-evidence";
import { HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS } from "@/lib/homepage-hero-snapshot";

const { restore, persist, liveRead } = vi.hoisted(() => ({ restore: vi.fn(), persist: vi.fn(), liveRead: vi.fn() }));
vi.mock("@/lib/detail-evidence-persistence", () => ({ restoreDetailEvidence: restore, persistDetailEvidence: persist }));
const coinId = "usdt-tether";
const queryKey = FRONTEND_API_QUERY_DESCRIPTORS.stablecoinLiveSummary(coinId).queryKey;
const build = makeDetailEvidence(now / 1000 - 120, 0.99);
let disk: PromiseWithResolvers<DetailEvidence | null>;
let live: PromiseWithResolvers<DetailEvidence>;
const clients: QueryClient[] = [];
let hydrated: Root | undefined;
function client() {
  const value = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(value);
  return value;
}
function Summary() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey, queryFn: liveRead, retry: false });
  const selected = useDetailEvidence(coinId, { data: query.data?.data, meta: query.data?.meta },
    isDetailSnapshotQuery(queryClient, queryKey) || query.isError);
  return <div>
    <span data-testid="price">{selected.data?.price}</span>
    <span data-testid="provenance">{selected.isRetained ? "Retained" : "Current"} · {selected.meta?.updatedAt} · {selected.meta && "freshBudgetSec" in selected.meta ? selected.meta.freshBudgetSec : "unknown"}</span>
    <span>{query.isError ? "Refresh failed" : ""}</span>
  </div>;
}
function Page({ queryClient }: { queryClient: QueryClient }) {
  useState(() => {
    seedStablecoinDetailQueryCache(queryClient, { version: 1, stablecoinId: coinId, generatedAt: now,
      updatedAt: { liveSummary: build.meta.updatedAt! * 1000 }, lanes: { liveSummary: build.data } });
    return null;
  });
  return <QueryClientProvider client={queryClient}><DetailEvidenceProvider coinId={coinId}><Summary /></DetailEvidenceProvider></QueryClientProvider>;
}
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  disk = Promise.withResolvers<DetailEvidence | null>();
  live = Promise.withResolvers<DetailEvidence>();
  restore.mockImplementation(() => disk.promise);
  persist.mockResolvedValue(undefined);
  liveRead.mockImplementation(() => live.promise);
});
afterEach(() => {
  if (hydrated) act(() => hydrated!.unmount());
  hydrated = undefined;
  cleanup();
  for (const queryClient of clients.splice(0)) queryClient.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("detail display evidence after hydration", () => {
  it("preserves first markup and starts live immediately, restores newer evidence display-only, then qualifies live", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    container.innerHTML = renderToString(<Page queryClient={client()} />);
    const serverMarkup = container.innerHTML;
    const queryClient = client();
    const errors = vi.spyOn(console, "error");
    await act(async () => { hydrated = hydrateRoot(container, <Page queryClient={queryClient} />); });
    expect(container.innerHTML).toBe(serverMarkup);
    expect(liveRead).toHaveBeenCalledOnce();
    expect(persist).not.toHaveBeenCalled();
    await act(async () => { disk.resolve(makeDetailEvidence(now / 1000 - 60, 1.02)); });
    await waitFor(() => expect(screen.getByTestId("price").textContent).toBe("1.02"));
    expect(screen.getByTestId("provenance").textContent).toBe(`Retained · ${now / 1000 - 60} · 600`);
    expect(queryClient.getQueryData<DetailEvidence>(queryKey)?.data.price).toBe(0.99);
    await act(async () => { live.resolve(makeDetailEvidence(now / 1000, 1.03)); });
    await waitFor(() => expect(screen.getByTestId("price").textContent).toBe("1.03"));
    expect(screen.getByTestId("provenance").textContent).toContain("Current");
    expect(persist).toHaveBeenCalledWith(coinId, makeDetailEvidence(now / 1000, 1.03));
    expect(liveRead).toHaveBeenCalledOnce();
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(/hydration|did not match/i);
    container.remove();
  });

  it("does not allow a late restore to roll back newer live data", async () => {
    const queryClient = client();
    render(<Page queryClient={queryClient} />);
    await act(async () => { live.resolve(makeDetailEvidence(now / 1000, 1.03)); });
    await waitFor(() => expect(screen.getByTestId("price").textContent).toBe("1.03"));
    await act(async () => { disk.resolve(makeDetailEvidence()); });
    expect(screen.getByTestId("price").textContent).toBe("1.03");
    expect(screen.getByTestId("provenance").textContent).toContain("Current");
  });

  it("retains original dates after live failure without saving the failed seed as live", async () => {
    render(<Page queryClient={client()} />);
    await act(async () => { live.reject(new Error("offline")); });
    await waitFor(() => expect(screen.getByText("Refresh failed")).toBeTruthy());
    await act(async () => { disk.resolve(makeDetailEvidence()); });
    await waitFor(() => expect(screen.getByTestId("provenance").textContent).toContain("Retained"));
    expect(persist).not.toHaveBeenCalled();
  });

  it("does not qualify an older build overlay when its equal-history-clock live refresh fails", async () => {
    render(<Page queryClient={client()} />);
    const saved = makeDetailEvidence(build.meta.updatedAt!, 1.02);
    saved.data.priceUpdatedAt = now / 1000 - 60;
    saved.data.supplyObservedAt = now / 1000 - 60;
    await act(async () => { disk.resolve(saved); });
    await waitFor(() => expect(screen.getByTestId("price").textContent).toBe("1.02"));
    await act(async () => { live.reject(new Error("offline")); });
    await waitFor(() => expect(screen.getByText("Refresh failed")).toBeTruthy());
    expect(screen.getByTestId("price").textContent).toBe("1.02");
    expect(screen.getByTestId("provenance").textContent).toContain("Retained");
    expect(persist).not.toHaveBeenCalled();
  });

  it("reevaluates producer expiry while mounted without any live settlement", async () => {
    render(<Page queryClient={client()} />);
    await act(async () => { disk.resolve(makeDetailEvidence()); });
    await waitFor(() => expect(screen.getByTestId("provenance").textContent).toContain("Retained"));
    vi.useFakeTimers();
    // A fresh provider clock is installed on remount so its minute timer is controlled.
    cleanup();
    const queryClient = client();
    render(<Page queryClient={queryClient} />);
    await act(async () => { await Promise.resolve(); });
    vi.spyOn(Date, "now").mockReturnValue(now + HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByTestId("provenance").textContent).toContain("Current");
    expect(screen.getByTestId("price").textContent).toBe("0.99");
    vi.useRealTimers();
  });
});
