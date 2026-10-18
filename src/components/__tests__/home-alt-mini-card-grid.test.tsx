// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeAltMiniCardGrid } from "@/components/home-alt-mini-card-grid";

vi.mock("@/components/home-alt-mini-cards/active-depegs-card", () => ({ ActiveDepegsCard: () => null }));
vi.mock("@/components/home-alt-mini-cards/mint-burn-card", () => ({ MintBurnCard: () => null }));
vi.mock("@/components/home-alt-mini-cards/peg-health-card", () => ({ PegHealthCard: () => null }));
vi.mock("@/components/home-alt-mini-cards/psi-band-card", () => ({ PsiBandCard: () => null }));
vi.mock("@/components/home-alt-mini-cards/recent-freezes-card", () => ({ RecentFreezesCard: () => null }));
vi.mock("@/components/home-alt-mini-cards/supply-moves-card", () => ({ SupplyMovesCard: () => null }));
vi.mock("@/lib/fonts/digest", () => ({ digestDisplay: { className: "digest-font" } }));
vi.mock("next/link", async () => {
  // The helper must load inside the hoisted mock factory.
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

const clients: QueryClient[] = [];
const edition = { digestTitle: "Current headline", editionNumber: 400, generatedAt: 1_700_000_000, slug: "2023-11-14" };
const promo = {
  latest: { ...edition, excerpt: "Current excerpt." },
  previousEditions: [
    { ...edition, digestTitle: "Previous headline", editionNumber: 399 },
    { ...edition, digestTitle: "Earlier headline", editionNumber: 398 },
  ],
};

function setupSlot(initialWidth: number) {
  let width = initialWidth;
  let publish: (() => void) | undefined;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { publish = callback; }
    observe() {}
    disconnect() {}
  });
  const fetchMock = vi.fn(async (_input: string | URL | Request) => Response.json(promo));
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const tree = <QueryClientProvider client={client}><HomeAltMiniCardGrid /></QueryClientProvider>;
  return {
    tree, client, fetchMock,
    resize(nextWidth: number) {
      width = nextWidth;
      act(() => publish?.());
    },
  };
}

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("HomeAltMiniCardGrid digest visibility", () => {
  it("keeps the desktop slot reserved on the server without mounting digest queries", () => {
    const { tree, fetchMock } = setupSlot(400);
    const html = renderToString(tree);
    expect(html).toContain("@4xl:auto-rows-[322px]");
    expect(html).toContain("hidden @4xl:col-span-1 @4xl:block");
    expect(html).not.toContain("Daily Digest");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("makes zero digest requests while CSS hides the slot and mounts only the bounded projection when shown", async () => {
    const { tree, client, fetchMock, resize } = setupSlot(0);
    const view = render(tree);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(screen.queryByText("Daily Digest")).toBeNull();

    resize(400);
    await waitFor(() => expect(client.getQueryState(["digest-promo"])?.status).toBe("success"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/digest-promo");
    expect(client.getQueryState(["digest-archive"])).toBeUndefined();
    expect(client.getQueryState(["daily-digest"])).toBeUndefined();
    expect(screen.getByText(/Current headline/).textContent).toBe("#400 — Current headline");
    expect(screen.getByText(/Previous headline/).textContent).toBe("#399 — Previous headline");
    expect(screen.getByText(/Earlier headline/).textContent).toBe("#398 — Earlier headline");
    expect(screen.getByText("Current excerpt.")).toBeTruthy();

    resize(0);
    expect(screen.queryByText("Daily Digest")).toBeNull();
    expect(client.getQueryCache().find({ queryKey: ["digest-promo"] })?.getObserversCount()).toBe(0);
    expect(Array.from(view.container.querySelectorAll("div")).some((node) => node.classList.contains("@4xl:auto-rows-[322px]"))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps unavailable current copy and blank prior leaves without fabricating archive titles", async () => {
    const { tree, client } = setupSlot(400);
    client.setQueryData(["digest-promo"], { latest: null, previousEditions: [] });
    render(tree);
    expect(screen.getByText("Read the latest edition on Telegram")).toBeTruthy();
    expect(screen.queryByText(/Previous headline/)).toBeNull();
    expect(screen.getByRole("link", { name: "Read on Telegram" })).toBeTruthy();
  });
});
