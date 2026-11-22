// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.useRealTimers());
vi.mock("@/hooks/use-hydrated", () => ({ useHydrated: () => true }));

vi.mock("@/hooks/use-blacklist-events", () => ({
  useBlacklistSummary: vi.fn(),
}));

import { FreezeSeizureModule, type FreezeSeizureModuleProps } from "../freeze-seizure-card";
import { useBlacklistSummary } from "@/hooks/use-blacklist-events";
import type { BlacklistabilityClientSummary } from "@/lib/stablecoin-detail-blacklistability-client";
import type { TransferReviewView } from "@/lib/transfer-review";
import type { ApiQueryWithMetaResult } from "@/hooks/use-api-query";
import type { BlacklistSummaryResponse } from "@shared/types/blacklist";
import type { ApiMeta } from "@/lib/api";

type UsageResult = ApiQueryWithMetaResult<BlacklistSummaryResponse>;

const SUMMARY: BlacklistabilityClientSummary = {
  status: "freezable",
  statusLabel: "Freezable",
  statusToneClass: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  statusNote: "A reviewed issuer or protocol control can freeze or seize this token in holders' wallets.",
  evidence: "The canonical implementation exposes owner-only addBlackList and destroyBlackFunds.",
  basisLabel: "Sourced review",
  sourceFreeRationale: null,
  upstreamLabel: null,
  sources: [{ label: "Verified USDT source", url: "https://example.com/usdt" }],
  reviewedAt: "2026-08-08",
};

function deployment(chainName: string, scope: string, scopeLabel: string, posture: string, postureLabel: string) {
  return {
    key: `${chainName}:0x1`,
    chainId: chainName.toLowerCase(),
    chainName,
    scope,
    scopeLabel,
    posture,
    postureLabel,
    evidence: `${chainName} deployment reviewed.`,
    sources: [],
  };
}

const TRANSFER_REVIEW: TransferReviewView = {
  reviewedAt: "2026-07-01",
  mixedPosture: true,
  deployments: [
    deployment("Ethereum", "canonical", "Canonical", "restrictable", "Restrictable"),
    deployment("Plasma", "material-bridge", "Bridged", "permissionless", "Permissionless"),
    deployment("Solana", "material-bridge", "Bridged", "permissionless", "Permissionless"),
  ],
};

function usageResult(result: Partial<UsageResult>) {
  vi.mocked(useBlacklistSummary).mockReturnValue({
    data: undefined,
    isLoading: false,
    error: null,
    dataUpdatedAt: 0,
    ...result,
  } as unknown as UsageResult);
}

function statsFor(symbol: string, values: { events: number; addresses: number; frozen: number; destroyed: number }) {
  return {
    data: {
      stats: {
        perCoinTotalEvents: { [symbol]: values.events },
        perCoinFrozenAddressCount: { [symbol]: values.addresses },
        perCoinFrozenTotal: { [symbol]: values.frozen },
        perCoinDestroyedTotal: { [symbol]: values.destroyed },
        valuationCoverage: {
          perCoinFrozen: { [symbol]: { knownCount: values.frozen > 0 ? 1 : 0, unavailableCount: 0 } },
          perCoinDestroyed: { [symbol]: { knownCount: values.destroyed > 0 ? 1 : 0, unavailableCount: 0 } },
        },
      },
    },
    dataUpdatedAt: Date.now(),
  } as unknown as Partial<UsageResult>;
}

function renderModule(props: Partial<FreezeSeizureModuleProps> = {}) {
  return render(<FreezeSeizureModule summary={SUMMARY} symbol="USDT" variant="tile" {...props} />);
}

function rail() {
  return screen.getByRole("img");
}

describe("FreezeSeizureModule", () => {
  beforeEach(() => {
    vi.mocked(useBlacklistSummary).mockReset();
    usageResult({});
  });

  it("renders nothing without a review", () => {
    const { container, rerender } = render(<FreezeSeizureModule summary={null} symbol="USDT" variant="tile" />);
    expect(container.firstChild).toBeNull();
    rerender(<FreezeSeizureModule symbol="USDT" variant="tile" />);
    expect(container.firstChild).toBeNull();
  });

  it("owns the freeze-seizure anchor as an h3 module with the status chip in its header", () => {
    const { container } = renderModule();
    const section = container.querySelector("section#freeze-seizure");
    expect(section).toBeTruthy();
    const heading = screen.getByRole("heading", { level: 3 });
    expect(section?.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(section?.textContent).toContain(SUMMARY.statusLabel);
  });

  it("names the possible classification Restrictable in the badge, rail and spoken rail, matching its verdict", () => {
    const summary = { ...SUMMARY, status: "possible" as const, statusLabel: "Possible" };
    renderModule({ summary, transferReview: TRANSFER_REVIEW });
    const drawn = rail();
    expect(drawn.textContent).toContain("Restrictable");
    expect(drawn.getAttribute("aria-label")).toContain("restrictable, no holder-targeted freeze");
    expect(drawn.textContent).not.toMatch(/freezable|possible/i);
    expect(drawn.getAttribute("aria-label")).not.toMatch(/freezable/i);
    // The badge never says more than the prose: no holder-targeted freeze, an admin control could restrict.
    const root = document.getElementById("freeze-seizure")!;
    expect(root.querySelector("[data-slot='badge']")?.textContent).toBe("Restrictable");
    expect(root.textContent).toMatch(/No power to freeze one holder was found, but an admin control/);
  });

  it("omits the Power and scope visual fold when only a single station would repeat the header badge", () => {
    renderModule();
    expect(screen.queryByText("Power and scope")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it.each([
    ["freezable", "Freezable"],
    ["not-freezable", "Not freezable"],
    ["inherited", "Upstream freeze risk"],
  ] as const)("labels the %s badge in the shared freeze vocabulary", (status, label) => {
    renderModule({ summary: { ...SUMMARY, status, upstreamLabel: null } });
    expect(document.getElementById("freeze-seizure")!.querySelector("[data-slot='badge']")?.textContent).toBe(label);
  });

  it("feeds an inherited power from the named upstream asset", () => {
    renderModule({
      summary: { ...SUMMARY, status: "inherited", statusLabel: "Upstream", upstreamLabel: "USD Coin" },
    });
    const text = rail().textContent ?? "";
    expect(text).toContain("USD Coin");
    expect(text.indexOf("USD Coin")).toBeLessThan(text.lastIndexOf("Upstream"));
    expect(rail().getAttribute("aria-label")).toContain("USD Coin");
  });

  it("keeps an unnamed inherited power to one station rather than inventing an upstream", () => {
    renderModule({ summary: { ...SUMMARY, status: "inherited", statusLabel: "Upstream", upstreamLabel: null } });
    const root = document.getElementById("freeze-seizure")!;
    expect(root.querySelector("[data-slot='badge']")?.textContent).toBe("Upstream freeze risk");
    expect(screen.queryByRole("img")).toBeNull();
    expect(root.textContent).not.toMatch(/via /i);
  });

  it("groups the transfer review by scope and posture and lists every deployment in a fold", () => {
    renderModule({ transferReview: TRANSFER_REVIEW });
    // One chip per scope × posture pair; the chains behind it ride along.
    expect(screen.getByTitle("Ethereum")).toBeTruthy();
    expect(screen.getByTitle("Plasma, Solana")).toBeTruthy();
    expect(rail().getAttribute("aria-label")).toContain("2 bridged deployments permissionless");

    for (const chain of ["Ethereum", "Plasma", "Solana"]) {
      const row = screen.getByText(chain, { selector: "li span" });
      expect(row.closest("details")?.hasAttribute("open")).toBe(false);
    }
  });

  it("omits the used station for a coin the freeze tracker does not watch, without fetching", () => {
    usageResult(statsFor("DAI", { events: 4, addresses: 2, frozen: 500, destroyed: 0 }));
    renderModule({ symbol: "DAI", transferReview: TRANSFER_REVIEW });
    expect(rail().textContent).not.toMatch(/used/i);
    expect(vi.mocked(useBlacklistSummary).mock.calls.every(([options]) => options?.enabled === false)).toBe(true);
  });

  it("never prints a zero while a watched coin's usage is loading or unavailable", () => {
    usageResult({ isLoading: true });
    const { unmount } = renderModule({ transferReview: TRANSFER_REVIEW });
    expect(rail().textContent).not.toMatch(/used/i);
    expect(rail().textContent).not.toMatch(/\b0\b/);
    unmount();

    usageResult({ error: new Error("offline") });
    renderModule({ transferReview: TRANSFER_REVIEW });
    expect(rail().textContent).not.toMatch(/used/i);
    expect(rail().textContent).not.toMatch(/\b0\b/);
  });

  it("draws observed usage for a watched coin and drops zero-valued figures", () => {
    usageResult(statsFor("USDT", { events: 9, addresses: 3, frozen: 1_000_000, destroyed: 0 }));
    renderModule();
    const label = rail().getAttribute("aria-label") ?? "";
    expect(label).toMatch(/used/i);
    expect(label).toContain("3 addresses");
    expect(label).not.toMatch(/destroyed/i);
    expect(rail().textContent).not.toMatch(/\b0\b/);
  });

  it("draws the retained-ledger total as a frozen figure", () => {
    usageResult(statsFor("USDT", { events: 2, addresses: 1, frozen: 100, destroyed: 0 }));
    renderModule();
    const text = rail().textContent ?? "";
    expect(text).toMatch(/\$100 frozen/);
    expect(rail().getAttribute("aria-label")).toContain("$100 frozen");
    expect(rail().getAttribute("aria-label")).not.toContain("persistent freeze-ledger");
  });

  it("reads a fully released ledger as no active freezes rather than a frozen total", () => {
    usageResult(statsFor("USDT", { events: 2, addresses: 0, frozen: 100, destroyed: 0 }));
    renderModule();
    const text = rail().textContent ?? "";
    expect(text).toContain("No active freezes");
    expect(text).not.toMatch(/\$100 frozen/);
  });

  it("states a watched coin with no recorded event in words, not as zero", () => {
    usageResult(statsFor("USDT", { events: 0, addresses: 0, frozen: 0, destroyed: 0 }));
    renderModule();
    expect(rail().getAttribute("aria-label")).toMatch(/used/i);
    expect(rail().textContent).not.toMatch(/\d/);
  });

  it("merges the evidence, the rationale and the citations into one collapsed fold", () => {
    renderModule({ summary: { ...SUMMARY, sourceFreeRationale: "Resolved by the resolver." } });

    const fold = screen.getByText(SUMMARY.evidence).closest("details");
    expect(fold).toBeTruthy();
    expect(fold?.hasAttribute("open")).toBe(false);
    expect(screen.getByText("Resolved by the resolver.").closest("details")).toBe(fold);
    const link = screen.getByText("Verified USDT source").closest("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/usdt");
    expect(link?.closest("details")).toBe(fold);
    // Two notes plus one source.
    expect(fold?.querySelector("summary")?.textContent).toContain("(3)");
    // Single-station omits the redundant Power and scope fold, leaving only the merged provenance fold.
    expect(document.querySelectorAll("details")).toHaveLength(1);
  });

  it("keeps the merged provenance fold for a source-free review and states the missing source inside it", () => {
    renderModule({
      summary: { ...SUMMARY, basisLabel: "Rationale only", sources: [], sourceFreeRationale: "Resolved by the resolver." },
    });

    const fold = screen.getByText(SUMMARY.evidence).closest("details");
    const summaryLine = fold?.querySelector("summary")?.textContent ?? "";
    expect(summaryLine).toContain("Review notes & sources");
    // The evidence plus the source statement.
    expect(summaryLine).toContain("(2)");
    expect(screen.getByText("No public source.").closest("details")).toBe(fold);
    expect(screen.getByText(/Resolved by the resolver\./).closest("details")).toBe(fold);
    // Single-station omits the redundant Power and scope fold, leaving only the merged provenance fold.
    expect(document.querySelectorAll("details")).toHaveLength(1);
  });
});

it.each([
  { meta: { updatedAt: Math.floor(Date.now() / 1000) - 86_400, status: "fresh", freshBudgetSec: 60, degradedBudgetSec: 120 }, state: "stale" },
  { meta: { updatedAt: null, status: "unknown", ageSeconds: null }, state: "unavailable" },
  { meta: { updatedAt: Math.floor(Date.now() / 1000), status: "fresh", dependencies: { scanner: { status: "stale", reason: "scan-old" } } }, state: null },
] as { meta: ApiMeta; state: string | null }[])("qualifies observed zero freeze usage with its producer generation ($state)", ({ meta, state }) => {
  const receipt = Date.now();
  const result = { ...statsFor("USDT", { events: 0, addresses: 0, frozen: 0, destroyed: 0 }), meta, dataUpdatedAt: receipt };
  usageResult(result);
  const { container, rerender } = renderModule();
  const producerTime = meta.updatedAt != null ? new Date(meta.updatedAt * 1000).toISOString() : null;
  expect(container.querySelector("time")?.getAttribute("datetime")).toBe(producerTime);
  // A stale dependency under a current generation is operator signal; only stale or missing data is public.
  if (state) expect(container.querySelector(`[data-health-state="${state}"]`)).toBeTruthy();
  else expect(container.querySelector("[data-health-state]")).toBeNull();
  expect(rail().getAttribute("aria-label")).toMatch(/used/i);
  usageResult({ ...result, dataUpdatedAt: receipt + 30_000 });
  rerender(<FreezeSeizureModule summary={SUMMARY} symbol="USDT" variant="tile" />);
  expect(container.querySelector("time")?.getAttribute("datetime")).toBe(producerTime);
  usageResult({ ...result, error: new Error("refresh failed"), refetch: vi.fn() });
  rerender(<FreezeSeizureModule summary={SUMMARY} symbol="USDT" variant="tile" />);
  expect(container.querySelector("time")?.getAttribute("datetime")).toBe(producerTime);
  expect(screen.queryByText(/refresh failed/i)).toBeNull();
  expect(rail().getAttribute("aria-label")).toMatch(/used/i);
});

it("shows usage freshness in the header beside the status, never in the footer", () => {
  usageResult(statsFor("USDT", { events: 1, addresses: 1, frozen: 100, destroyed: 0 }));
  const { container } = renderModule();
  const time = container.querySelector("time");
  expect(time).toBeTruthy();
  expect(time!.closest("[aria-labelledby]")?.firstElementChild?.contains(time)).toBe(true);
});

it("draws the stacked connector under the chip column, not under the kickers", () => {
  usageResult(statsFor("USDT", { events: 1, addresses: 1, frozen: 100, destroyed: 0 }));
  renderModule();
  const connector = rail().querySelector("span[aria-hidden='true']");
  expect(connector?.className).toContain("ml-23");
});

it("ages retained freeze usage without changing its observation generation", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
  const receipt = Date.now();
  usageResult({
    ...statsFor("USDT", { events: 1, addresses: 1, frozen: 100, destroyed: 0 }), dataUpdatedAt: receipt,
    meta: { updatedAt: receipt / 1000, ageSeconds: 0, status: "fresh", freshBudgetSec: 60, degradedBudgetSec: 120 },
  });
  const { container } = renderModule();
  expect(container.querySelector("[data-health-state]")).toBeNull();
  act(() => vi.advanceTimersByTime(50));
  act(() => vi.advanceTimersByTime(60_001));
  expect(container.querySelector("[data-health-state]")).toBeNull();
  act(() => vi.advanceTimersByTime(60_000));
  expect(container.querySelector('[data-health-state="stale"]')).toBeTruthy();
  expect(container.querySelector("time")?.getAttribute("datetime")).toBe(new Date(receipt).toISOString());
});
