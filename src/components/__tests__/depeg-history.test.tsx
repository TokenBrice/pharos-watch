// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DepegHistory } from "@/components/depeg-history";
import type { DepegEvent, PegSummaryCoin } from "@shared/types";
import { makeEvent } from "./depeg.test-support";

const { useInfiniteDepegEventsMock } = vi.hoisted(() => ({
  useInfiniteDepegEventsMock: vi.fn(),
}));

vi.mock("@/hooks/use-depeg-events", () => ({
  useInfiniteDepegEvents: useInfiniteDepegEventsMock,
}));

afterEach(() => {
  useInfiniteDepegEventsMock.mockReset();
  vi.restoreAllMocks();
});


function mockEvents(events: DepegEvent[], overrides: Record<string, unknown> = {}) {
  const isFullyLoaded = overrides.isFullyLoaded ?? true;
  useInfiniteDepegEventsMock.mockReturnValue({
    data: { events, total: events.length, totalExact: true },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    isFetchingNextPage: false,
    loadedCount: events.length,
    isFullyLoaded,
    hasLoadedAllPages: isFullyLoaded,
    isAutoLoadCapped: false,
    hasNextPage: false,
    ...overrides,
  });
}

describe("DepegHistory provenance badges", () => {
  it("keeps the older worst incident after pagination regardless of the 90-day chart seed", () => {
    const now = Math.floor(Date.now() / 1000);
    const day = 86_400;
    const old = makeEvent({ id: 1, startedAt: now - 300 * day, endedAt: now - 290 * day, peakDeviationBps: -1200 });
    const recent = makeEvent({ id: 2, startedAt: now - 20 * day, endedAt: now - 19 * day, peakDeviationBps: -150 });
    mockEvents([recent], { isFullyLoaded: false, isFetchingNextPage: true });
    const view = render(<DepegHistory stablecoinId="usdc-circle"
      historyCoverage={{ startedAt: now - 90 * day, source: "first-observation", status: "verified" }} />);
    expect(screen.queryByText("Worst depeg")).toBeNull();
    mockEvents([recent, old]);
    view.rerender(<DepegHistory stablecoinId="usdc-circle"
      historyCoverage={{ startedAt: now - 90 * day, source: "first-observation", status: "verified" }} />);
    expect(screen.getByText("Worst depeg").parentElement?.textContent).toContain("-1200 bps");
    view.rerender(<DepegHistory stablecoinId="usdc-circle"
      historyCoverage={{ startedAt: now - 365 * day, source: "audited-replay", status: "verified" }} />);
    expect(screen.getByText("Worst depeg").parentElement?.textContent).toContain("-1200 bps");
  });
  it("withholds partial metrics until all history has loaded", () => {
    const events = [makeEvent()];
    mockEvents(events, { data: { events, total: 2, totalExact: true }, isFullyLoaded: false, isFetchingNextPage: true });
    const view = render(<DepegHistory stablecoinId="usdc-circle" />);
    expect(screen.getByText(/Loading full history.*1 \/ 2 incidents/)).toBeTruthy();
    expect(screen.queryByText("Worst depeg")).toBeNull();
    expect(screen.queryByText("Recorded recovery")).toBeNull();
    expect(screen.queryByLabelText("Go to next page")).toBeNull();
    mockEvents([...events, makeEvent({ id: 2, peakDeviationBps: -350, endedAt: null })]);
    view.rerender(<DepegHistory stablecoinId="usdc-circle" />);
    expect(screen.queryByText(/Loading full history/)).toBeNull();
    expect(screen.getByText("Worst depeg").parentElement?.textContent).toContain("-350 bps");
    expect(screen.getByText("Recorded recovery").parentElement?.textContent).toContain("Depegged now");
  });

  it("excludes disputed rows from incident and threshold-crossing counts while keeping them listed", () => {
    const events = [
      makeEvent({ id: 1, provenance: { auditVerdict: "disputed" }, constituentEventCount: 2 }),
      makeEvent({ id: 2, provenance: { auditVerdict: "false_positive" }, constituentEventCount: 3 }),
      makeEvent({ id: 3, provenance: { auditVerdict: "confirmed" }, constituentEventCount: 4 }),
      makeEvent({ id: 4, provenance: { auditVerdict: "legacy_unknown" } as never, constituentEventCount: 5 }),
    ];
    mockEvents(events, { data: { events, total: 2, totalExact: false } });
    render(<DepegHistory stablecoinId="usdc-circle" />);
    expect(screen.getByText("Incidents").parentElement?.textContent).toContain("2");
    expect(screen.getByText("Threshold crossings").parentElement?.textContent).toContain("9");
    expect(screen.getByTestId("stablecoin-depeg-history-table").querySelectorAll("tbody tr")).toHaveLength(4);
  });

  it("keeps a loaded-row lower bound honest when a disputed row is loaded first", () => {
    const events = [
      makeEvent({ id: 1, provenance: { auditVerdict: "disputed" } }),
      makeEvent({ id: 2, provenance: { auditVerdict: "confirmed" } }),
    ];
    mockEvents(events, { data: { events, total: 2, totalExact: false }, isFullyLoaded: false, isAutoLoadCapped: true });
    render(<DepegHistory stablecoinId="usdc-circle" />);
    expect(screen.getByText("Incidents").parentElement?.textContent).toContain("1+");
  });

  it("never presents the cursor API's inexact page total as the incident count", () => {
    const events = [makeEvent(), makeEvent({ id: 2 })];
    // includeTotal=false: `total` is a page lower bound (LUSD showed "newest 1,000 of 101").
    mockEvents(events, { data: { events, total: 3, totalExact: false }, isFullyLoaded: false, isAutoLoadCapped: true });
    render(<DepegHistory stablecoinId="usdc-circle" />);
    expect(screen.getByText("Incidents").parentElement?.textContent).toContain("2+");
    expect(screen.getByText(/Partial history: the newest 2 incidents are loaded/)).toBeTruthy();
    expect(screen.queryByText(/of 3 incidents/)).toBeNull();
  });

  it("offers retry after a failure with no retained rows", () => {
    const refetch = vi.fn();
    mockEvents([], { error: new Error("history unavailable"), refetch });
    render(<DepegHistory stablecoinId="usdc-circle" />);
    expect(screen.queryByTestId("stablecoin-depeg-history-table")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("keeps retained rows without a reader notice after a failed refresh (ADR-42)", () => {
    mockEvents([makeEvent()], { error: new Error("history unavailable"), refetch: vi.fn() });
    render(<DepegHistory stablecoinId="usdc-circle" />);
    expect(screen.getByTestId("stablecoin-depeg-history-table")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("keeps a complete retained list paginated after a failed refresh without claiming loading", () => {
    const now = Math.floor(Date.now() / 1000);
    const events = Array.from({ length: 30 }, (_, index) => makeEvent({
      id: index + 1, startedAt: now - index * 86_400,
    }));
    mockEvents(events, {
      error: new Error("refresh failed"),
      refetch: vi.fn(),
      isFullyLoaded: false,
      hasLoadedAllPages: true,
      isAutoLoadCapped: false,
      isFetchingNextPage: false,
      hasNextPage: false,
      data: { events, total: 30, totalExact: false, nextCursor: null },
    });
    render(<DepegHistory stablecoinId="usdc-circle" />);

    expect(screen.queryByText(/Loading full history/)).toBeNull();
    const incidents = screen.getByText("Incidents").parentElement!.textContent ?? "";
    expect(incidents).toContain("30");
    expect(incidents).not.toContain("30+");
    // Pagination stays available, so rows beyond the first fold remain reachable.
    fireEvent.click(screen.getByRole("button", { name: "Show all 30 incidents" }));
    expect(tableRowCount()).toBe(25);
    fireEvent.click(screen.getAllByRole("button", { name: "Go to next page" })[0]);
    expect(tableRowCount()).toBe(5);
  });

  it("renders pending_reason and confirmation_sources badges when present", () => {
    mockEvents([
      makeEvent({
        id: 42,
        confirmationSources: "DEX+CEX",
        pendingReason: "large-cap",
      }),
    ]);

    render(<DepegHistory stablecoinId="usdc-circle" />);

    expect(screen.getByTestId("stablecoin-depeg-history-table").getAttribute("data-table-id")).toBe(
      "stablecoin-depeg-history",
    );
    expect(screen.getByTestId("event-source").textContent).toContain("live");
    expect(screen.getByTestId("event-pending-reason").textContent).toContain("large cap");
    expect(screen.getByTestId("event-confirmed-by").textContent).toContain("DEX, CEX");
  });

  it("omits both badges for legacy events where provenance fields are null", () => {
    mockEvents([
      makeEvent({
        id: 7,
        confirmationSources: null,
        pendingReason: null,
      }),
    ]);

    render(<DepegHistory stablecoinId="usdc-circle" />);

    expect(screen.getByTestId("event-source").textContent).toContain("live");
    expect(screen.queryByTestId("event-pending-reason")).toBeNull();
    expect(screen.queryByTestId("event-confirmed-by")).toBeNull();
  });
});

describe("DepegHistory closure and occupancy claims", () => {
  const now = 1_800_000_000;
  const day = 86_400;
  const recent90d: NonNullable<PegSummaryCoin["recent90d"]> = {
    windowDays: 90, pegPct: 87.5, observedDays: 72, incidentCount: 2,
    thresholdCrossingCount: 3, worstDeviationBps: -300, coverageLimited: true,
  };

  it.each([
    ["coverage-lost-supply", 1, /coverage lost/i],
    ["superseded-direction", 1, /direction superseded/i],
    ["orphan-tracking-removed", 1, /asset removed/i],
    [null, null, /recovery unconfirmed/i],
  ] as const)("does not resurrect an older recovery after %s", (closeReason, recoveryPrice, reason) => {
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    mockEvents([
      makeEvent({ id: 1, startedAt: now - 60 * day, endedAt: now - 50 * day, closeReason: "recovered-primary" }),
      makeEvent({ id: 2, startedAt: now - 20 * day, endedAt: now - 10 * day, closeReason, recoveryPrice }),
    ]);
    render(<DepegHistory stablecoinId="usdc-circle" recent90d={recent90d} />);
    const recovery = screen.getByText("Recorded recovery").parentElement!;
    expect(recovery.textContent).toMatch(/tracking closed/i);
    expect(recovery.textContent).toMatch(reason);
    expect(recovery.textContent).toMatch(/continuity unavailable/i);
    expect(screen.queryByText(/\d+d (at peg|since last recorded recovery)/)).toBeNull();
    const occupancy = screen.getByRole("group", { name: /recent 90-day recorded-window peg occupancy/i });
    expect(occupancy.textContent).toMatch(/87\.5%.*recorded-window peg occupancy estimate/i);
    expect(occupancy.textContent).toMatch(/72d.*calculation basis/i);
    const description = document.getElementById(occupancy.getAttribute("aria-describedby")!)!;
    expect(description.textContent).toMatch(/not proof of recovery or continuous observation/i);
    expect(description.textContent).toMatch(/unobserved time/i);
  });

  it.each(["recovered-primary", "recovered-dex", "recovered-native", null, undefined] as const)(
    "qualifies time since recorded recovery for %s without claiming continuous at-peg coverage",
    (closeReason) => {
      vi.spyOn(Date, "now").mockReturnValue(now * 1000);
      mockEvents([makeEvent({ startedAt: now - 20 * day, endedAt: now, closeReason })]);
      render(<DepegHistory stablecoinId="usdc-circle" recent90d={recent90d} />);
      expect(screen.getByText(/0d since last recorded recovery/)).toBeTruthy();
      expect(screen.queryByText(/\d+d at peg/)).toBeNull();
      expect(screen.getByRole("group", { name: /recorded-window peg occupancy/i }).textContent).toMatch(/87\.5%.*estimate/i);
    },
  );

  it("qualifies occupancy without inferring a latest closure from incomplete history", () => {
    mockEvents([makeEvent({ closeReason: "coverage-lost-supply", recoveryPrice: null })], {
      isFullyLoaded: false, isAutoLoadCapped: true,
    });
    render(<DepegHistory stablecoinId="usdc-circle" recent90d={recent90d} />);
    expect(screen.queryByText("Recorded recovery")).toBeNull();
    expect(screen.queryByText(/Tracking closed \(/)).toBeNull();
    const occupancy = screen.getByRole("group", { name: /recorded-window peg occupancy/i });
    expect(occupancy.textContent).toMatch(/87\.5%.*estimate/i);
    expect(document.getElementById(occupancy.getAttribute("aria-describedby")!)?.textContent).toMatch(/unobserved time/i);
  });
});

function tableRowCount(): number {
  return screen.getByTestId("stablecoin-depeg-history-table").querySelectorAll("tbody tr").length;
}

describe("DepegHistory incident fold", () => {
  it("pages past 25 incidents then folds back to the newest six", () => {
    mockEvents(Array.from({ length: 27 }, (_, i) => makeEvent({
      id: i + 1, startedAt: 1_700_000_000 - i * 86_400, pendingReason: `incident-${i + 1}`,
    })));
    render(<DepegHistory stablecoinId="usdc-circle" />);
    const table = screen.getByTestId("stablecoin-depeg-history-table");
    const identities = () => within(table).getAllByTestId("event-pending-reason").map((node) => node.textContent);
    expect(identities()).toEqual(Array.from({ length: 6 }, (_, i) => `incident ${i + 1}`));
    fireEvent.click(screen.getByRole("button", { name: "Show all 27 incidents" }));
    expect(tableRowCount()).toBe(25);
    fireEvent.click(screen.getAllByRole("button", { name: "Go to next page" })[0]);
    expect(identities()).toEqual(["incident 26", "incident 27"]);
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(identities()).toEqual(Array.from({ length: 6 }, (_, i) => `incident ${i + 1}`));
    expect(screen.queryByLabelText("Go to next page")).toBeNull();
  });

});

describe("DepegHistory coverage anchor", () => {
  it("renders a UTC-day anchor on the reader's calendar day west of Greenwich", () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      mockEvents([makeEvent()]);
      render(<DepegHistory stablecoinId="usdc-circle" historyCoverage={{
        startedAt: Date.UTC(2024, 2, 1) / 1000, source: "asset-age", status: "assumed",
      }} />);
      const anchor = screen.getByText(/Score coverage:/).textContent ?? "";
      expect(anchor).toContain("since Mar 1, 2024");
      expect(anchor).not.toContain("Feb 29, 2024");
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it("publishes no second incident total beside the panel's own dispute-filtered count", () => {
    mockEvents([makeEvent({ provenance: { auditVerdict: "disputed" } })]);
    render(<DepegHistory stablecoinId="usdc-circle" historyCoverage={{
      startedAt: Date.UTC(2026, 1, 11) / 1000, source: "asset-age", status: "assumed",
    }} />);
    const anchor = screen.getByText(/Score coverage:/).textContent ?? "";
    expect(anchor).toContain("since Feb 11, 2026");
    expect(anchor).not.toMatch(/incident/i);
  });
});

describe("DepegHistory embedded preview handoff", () => {
  it("suppresses its skeleton while loading and reports that the shell preview owns the panel", () => {
    const onDisplayStateChange = vi.fn();
    mockEvents([], { data: undefined, isLoading: true, isFullyLoaded: false });
    const { container } = render(
      <DepegHistory stablecoinId="usdc-circle" embeddedPreview onDisplayStateChange={onDisplayStateChange} />,
    );

    expect(container.firstChild).toBeNull();
    expect(onDisplayStateChange).toHaveBeenLastCalledWith(false);
  });

  it("keeps the preview beside the retry notice when the read fails with nothing admitted", () => {
    const onDisplayStateChange = vi.fn();
    mockEvents([], { error: new Error("history unavailable"), refetch: vi.fn() });
    const { container } = render(
      <DepegHistory stablecoinId="usdc-circle" embeddedPreview onDisplayStateChange={onDisplayStateChange} />,
    );

    expect(within(container).getByRole("button", { name: /retry/i })).toBeTruthy();
    expect(container.querySelector("table")).toBeNull();
    expect(onDisplayStateChange).toHaveBeenLastCalledWith(false);
  });

  it("takes ownership once a partial response is renderable", async () => {
    const onDisplayStateChange = vi.fn();
    mockEvents([makeEvent()], { data: { events: [makeEvent()], total: 2, totalExact: true }, isFullyLoaded: false, isFetchingNextPage: true });
    const { container } = render(
      <DepegHistory stablecoinId="usdc-circle" embeddedPreview onDisplayStateChange={onDisplayStateChange} />,
    );

    expect(container.querySelectorAll("table")).toHaveLength(1);
    await waitFor(() => expect(onDisplayStateChange).toHaveBeenLastCalledWith(true));
  });

  it("takes ownership of a successfully empty result without rewriting historical provenance", async () => {
    const onDisplayStateChange = vi.fn();
    mockEvents([]);
    render(
      <DepegHistory stablecoinId="usdc-circle" embeddedPreview onDisplayStateChange={onDisplayStateChange} />,
    );

    expect(screen.getByText("No depeg incidents are recorded in the observed coverage window.")).toBeTruthy();
    expect(screen.queryByText(/archived incidents/)).toBeNull();
    expect(screen.queryByText(/Recorded history; coverage may be incomplete/)).toBeNull();
    await waitFor(() => expect(onDisplayStateChange).toHaveBeenLastCalledWith(true));
  });

  it("renders no duplicate table when it owns the panel", async () => {
    const onDisplayStateChange = vi.fn();
    mockEvents([makeEvent()]);
    const { container } = render(
      <DepegHistory stablecoinId="usdc-circle" embeddedPreview onDisplayStateChange={onDisplayStateChange} />,
    );

    expect(container.querySelectorAll("table")).toHaveLength(1);
    expect(screen.getAllByTestId("stablecoin-depeg-history-table")).toHaveLength(1);
    await waitFor(() => expect(onDisplayStateChange).toHaveBeenLastCalledWith(true));
  });
});
