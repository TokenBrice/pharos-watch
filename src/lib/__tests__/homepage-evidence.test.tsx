// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { HomepageSnapshot } from "@shared/types/homepage";
import { HomepageEvidenceProvider } from "@/lib/homepage-evidence";
import { HomeAltHero } from "@/components/home-alt-hero";
import { HOMEPAGE_EVIDENCE_TEST_NOW as now, makeHomepageEvidence } from "@/test/fixtures/homepage-evidence";

const { restore, persist, liveRead } = vi.hoisted(() => ({ restore: vi.fn(), persist: vi.fn(), liveRead: vi.fn() }));
vi.mock("@/lib/homepage-evidence-persistence", () => ({
  HOMEPAGE_EVIDENCE_QUERY_KEY: ["homepage-snapshot"], restoreHomepageEvidence: restore, persistHomepageEvidence: persist,
}));
vi.mock("@/hooks/api-hooks", () => ({
  useHomepageSnapshot: () => useQuery({ queryKey: ["homepage-snapshot"], queryFn: liveRead, retry: false }),
}));
vi.mock("@/components/home-alt-hero-chart-gate", () => ({ HomeAltHeroChartGate: () => <div /> }));
vi.mock("@/lib/analytics", () => ({ trackFreshDataReady: vi.fn() }));

let disk: PromiseWithResolvers<HomepageSnapshot | null>;
let live: PromiseWithResolvers<HomepageSnapshot>;
const clients: QueryClient[] = [];
let hydrated: Root | undefined;
function client() {
  const value = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(value);
  return value;
}
function Page({ queryClient, children }: { queryClient: QueryClient; children?: ReactNode }) {
  const fallback = makeHomepageEvidence(now / 1000 - 120).market.data!;
  return <QueryClientProvider client={queryClient}><HomepageEvidenceProvider>
    <HomeAltHero snapshot={fallback} fallbackSelectedAtMs={now} />{children}
  </HomepageEvidenceProvider></QueryClientProvider>;
}
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  disk = Promise.withResolvers<HomepageSnapshot | null>();
  live = Promise.withResolvers<HomepageSnapshot>();
  restore.mockImplementation(() => disk.promise);
  persist.mockResolvedValue(undefined);
  liveRead.mockImplementation(() => live.promise);
});
afterEach(() => {
  if (hydrated) act(() => hydrated!.unmount());
  hydrated = undefined;
  cleanup();
  for (const queryClient of clients.splice(0)) queryClient.clear();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("homepage evidence after hydration", () => {
  it("keeps server/first-client markup, launches live without waiting for disk, then qualifies retained values", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    container.innerHTML = renderToString(<Page queryClient={client()} />);
    const serverMarkup = container.innerHTML;
    const queryClient = client();
    const errors = vi.spyOn(console, "error");
    await act(async () => { hydrated = hydrateRoot(container, <Page queryClient={queryClient} />); });
    expect(container.innerHTML).toBe(serverMarkup);
    expect(liveRead).toHaveBeenCalledOnce();
    expect(queryClient.getQueryData(["homepage-snapshot"])).toBeUndefined();
    await act(async () => { disk.resolve(makeHomepageEvidence(now / 1000 - 60)); });
    // Retained lanes render as-is; the homepage never labels them (docs/homepage.md#data-health).
    await waitFor(() => expect(screen.getByRole("link", { name: /PSI/ }).textContent).toContain("91.9"));
    expect(screen.getByRole("link", { name: /active depeg/ }).textContent).toContain("1active depeg");
    expect(document.body.textContent).not.toMatch(/Retained|retained|stale after/);
    expect(screen.getByText(/^As of October 18, 2026/)).toBeTruthy();
    expect(queryClient.getQueryData(["homepage-snapshot"])).toBeUndefined();
    await act(async () => { live.resolve(makeHomepageEvidence()); });
    await waitFor(() => expect(queryClient.getQueryData(["homepage-snapshot"])).toEqual(makeHomepageEvidence()));
    expect(screen.getByText(/^As of October 18, 2026/)).toBeTruthy();
    expect(persist).toHaveBeenCalledWith(makeHomepageEvidence());
    expect(liveRead).toHaveBeenCalledOnce();
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(/hydration|did not match/i);
    container.remove();
  });

  it("retains dated evidence after a failed live read, without a warning or a calm claim", async () => {
    render(<Page queryClient={client()} />);
    await act(async () => { disk.resolve(makeHomepageEvidence(now / 1000 - 60)); });
    await waitFor(() => expect(screen.getByRole("link", { name: /PSI/ }).textContent).toContain("91.9"));
    await act(async () => { live.reject(new Error("live offline")); });
    await waitFor(() => expect(screen.getByRole("link", { name: /active depeg/ }).textContent).toContain("1active depeg"));
    expect(document.body.textContent).not.toMatch(/Refresh failed|Retained|retained/);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("Bedrock").className).toContain("text-foreground");
    expect(persist).not.toHaveBeenCalled();
  });

  it("does not let a late restore overwrite a newer live generation", async () => {
    const queryClient = client();
    render(<Page queryClient={queryClient} />);
    await act(async () => { live.resolve(makeHomepageEvidence()); });
    await waitFor(() => expect(screen.getByRole("link", { name: /PSI/ }).textContent).toContain("91.9"));
    await act(async () => { disk.resolve(makeHomepageEvidence(now / 1000 - 60)); });
    expect(document.body.textContent).not.toMatch(/Retained|retained/);
    expect(queryClient.getQueryData(["homepage-snapshot"])).toEqual(makeHomepageEvidence());
  });
});
