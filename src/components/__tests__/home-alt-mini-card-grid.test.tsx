// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeAltMiniCardGrid } from "@/components/homepage/home-alt-mini-card-grid";
import { DailyDigestCard } from "@/components/home-alt-mini-cards/daily-digest-card";

vi.mock("@/components/home-alt-mini-cards/active-depegs-card", () => ({ ActiveDepegsCard: () => <div data-testid="active-depegs-card" /> }));
vi.mock("@/components/home-alt-mini-cards/mint-burn-card", () => ({ MintBurnCard: () => <div data-testid="mint-burn-card" /> }));
vi.mock("@/components/home-alt-mini-cards/peg-health-card", () => ({ PegHealthCard: () => <div data-testid="peg-health-card" /> }));
vi.mock("@/components/home-alt-mini-cards/psi-band-card", () => ({ PsiBandCard: () => <div data-testid="psi-band-card" /> }));
vi.mock("@/components/home-alt-mini-cards/recent-freezes-card", () => ({ RecentFreezesCard: () => <div data-testid="recent-freezes-card" /> }));
vi.mock("@/components/home-alt-mini-cards/supply-moves-card", () => ({ SupplyMovesCard: () => <div data-testid="supply-moves-card" /> }));
vi.mock("@/lib/fonts/digest", () => ({ digestDisplay: { className: "digest-font" } }));

const pegState = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock("@/hooks/api-hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/api-hooks")>()),
  usePegSummary: () => ({ data: pegState.data, isLoading: false, error: null }),
  useStabilityIndex: () => ({ data: undefined, isLoading: false, error: null, dataUpdatedAt: 0 }),
}));
vi.mock("@/hooks/use-mint-burn-flows", () => ({
  useMintBurnFlows: () => ({ data: undefined, isLoading: false, error: null }),
}));
vi.mock("@/hooks/use-blacklist-events", () => ({
  useBlacklistSummary: () => ({ data: undefined, isLoading: false, error: null }),
}));
vi.mock("@/hooks/use-stablecoins", () => ({
  useStablecoins: () => ({ data: undefined, isLoading: false, error: null }),
}));
vi.mock("next/link", async () => {
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

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return { client, ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>) };
}

afterEach(() => {
  pegState.data = undefined;
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
});

describe("HomeAltMiniCardGrid locked layout (Q6/Q7)", () => {
  it("permanently places ActiveDepegsCard in Row 1 alongside PegHealth, PSI, and Mint/Burn without swapping", () => {
    const view = renderWithClient(<HomeAltMiniCardGrid />);
    const desktop = screen.getByTestId("desktop-pulse-bento");
    const rows = desktop.querySelectorAll(":scope > div.grid");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.firstElementChild?.getAttribute("data-testid")).toBe("active-depegs-card");
    expect(rows[0]!.children[1]?.getAttribute("data-testid")).toBe("peg-health-card");
    expect(rows[1]!.firstElementChild?.getAttribute("data-testid")).toBe("supply-moves-card");
    expect(rows[1]!.lastElementChild?.getAttribute("data-testid")).toBe("recent-freezes-card");
    expect(screen.getAllByTestId("active-depegs-card")).toHaveLength(1);
    expect(screen.queryByText("Daily Digest")).toBeNull();
    view.unmount();
  });

  it("renders a dense mobile 2x2 KPI block with neutral unavailable placeholders", () => {
    renderWithClient(<HomeAltMiniCardGrid />);
    const mobile = screen.getByTestId("mobile-pulse-kpi-grid");
    expect(mobile.textContent).toContain("Active depegs");
    expect(mobile.textContent).toContain("Peg health");
    expect(mobile.textContent).toContain("Stability Index");
    expect(mobile.textContent).toContain("Mint / Burn");
    expect(mobile.textContent).toContain("Updating");
  });
});

describe("DailyDigestCard full-width editorial strip", () => {
  it("renders the latest edition and dated prior archive leaves without clipping", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);
    client.setQueryData(["digest-promo"], promo);
    render(<QueryClientProvider client={client}><DailyDigestCard /></QueryClientProvider>);

    expect(screen.getByRole("heading", { name: "Daily Digest" })).toBeTruthy();
    expect(screen.getByText(/Current headline/).textContent).toBe("#400: Current headline");
    expect(screen.getByText(/Previous headline/).textContent).toBe("Nov 14, 2023 · #399: Previous headline");
    expect(screen.getByText(/Earlier headline/).textContent).toBe("Nov 14, 2023 · #398: Earlier headline");
    expect(screen.getByText("Current excerpt.")).toBeTruthy();
  });

  it("keeps unavailable current copy and blank prior leaves without fabricating archive titles", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);
    client.setQueryData(["digest-promo"], { latest: null, previousEditions: [] });
    render(<QueryClientProvider client={client}><DailyDigestCard /></QueryClientProvider>);

    expect(screen.getByText("Read the latest edition on Telegram")).toBeTruthy();
    expect(screen.queryByText(/Previous headline/)).toBeNull();
    expect(screen.getByRole("link", { name: "Read on Telegram" })).toBeTruthy();
  });
});
