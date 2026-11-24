// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveDepegOutlook, StablecoinDepegResolverCard } from "../depeg-resolver-card";
import { getResolution, getTierMeta, getTierVocabulary } from "@/components/depeg/depeg-resolver-row-card-model";
import { DDR_TEST_META, makeFrozenDdrV2Row } from "@/components/depeg-resolver-test-support";
import { cleanupFrontendTest } from "@/test-utils/frontend";

const { queryMock, enabledMock } = vi.hoisted(() => ({ queryMock: vi.fn(), enabledMock: vi.fn(() => true) }));
vi.mock("@/hooks/api-hooks", () => ({ useDepegResolver: queryMock }));
vi.mock("@/lib/feature-flags", () => ({ isDepegResolverEnabled: enabledMock }));

// Hydrate synchronously so the shared banner ages against the fake wall clock; fake timers
// here fake only setTimeout and Date, so they never capture this stub.
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
});

afterEach(() => {
  cleanupFrontendTest();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  enabledMock.mockReturnValue(true);
});

describe("StablecoinDepegResolverCard", () => {
  it.each([
    ["an empty snapshot", DDR_TEST_META, [], "lusd-liquity"],
    ["a coin absent from a stale book", { ...DDR_TEST_META, degraded: true, degradedReason: "stale-cache" }, [makeFrozenDdrV2Row()], "usdc-circle"],
  ])("omits %s, never unavailable", (_case, _meta, rows, id) => {
    queryMock.mockReturnValue({ data: { _meta, rows }, error: null, refetch: vi.fn() });
    expect(render(<StablecoinDepegResolverCard stablecoinId={id} />).container.innerHTML).toBe("");
    // No book row: no resolver state, no link.
    const outlook = render(<ActiveDepegOutlook stablecoinId={id} symbol="X" deviationBps={null} />).container;
    expect(outlook.querySelector("[data-active-depeg-alert]")?.getAttribute("data-active-depeg-alert")).toBe("none");
    expect(outlook.querySelector("a")).toBeNull();
  });

  it.each([
    ["loading", undefined, null, "Loading forecast"],
    ["not locked", "pending", null, "Forecast not locked yet"],
    ["unreadable", undefined, new Error("HTTP 502"), "Forecast unavailable"],
  ] as const)("stands in with the live deviation while the forecast is %s", (_case, rows, error, kicker) => {
    const row = makeFrozenDdrV2Row();
    const pending = { ...row, kind: "pending", prediction: { ...row.prediction, state: "pending_lock" }, frozen: null };
    queryMock.mockReturnValue({ data: rows ? { _meta: DDR_TEST_META, rows: [pending] } : undefined, error });
    render(<ActiveDepegOutlook stablecoinId={row.stablecoinId} symbol="LUSD" deviationBps={-4570} />);
    screen.getByText("LUSD is trading 45.7% below its peg");
    screen.getByText(kicker);
    expect(screen.getByRole("link").getAttribute("href")).toBe("#depeg-resolver");
  });

  it.each([
    ["a failed first read", undefined, new Error("HTTP 502"), "temporarily unavailable"],
    ["a degraded empty snapshot", { _meta: { ...DDR_TEST_META, degraded: true, degradedReason: "no-valid-snapshot" }, rows: [] }, null, "Snapshot reason: no-valid-snapshot"],
  ])("shows %s as unavailable with a retry", (_case, data, error, text) => {
    const refetch = vi.fn();
    queryMock.mockReturnValue({ data, error, refetch });
    render(<StablecoinDepegResolverCard stablecoinId="lusd-liquity" />);
    expect(screen.getByRole("alert").closest("section")?.textContent).toContain(text);
    fireEvent.click(screen.getByRole("button", { name: "Retry depeg duration resolver" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("retains stale-cache rows without a private stale notice or raw reason", () => {
    queryMock.mockReturnValue({
      data: { _meta: { ...DDR_TEST_META, degraded: true, degradedReason: "stale-cache" }, rows: [makeFrozenDdrV2Row()] },
      error: null, refetch: vi.fn(),
    });
    const { container } = render(<StablecoinDepegResolverCard stablecoinId="lusd-liquity" />);
    const region = screen.getByRole("region", { name: "Depeg Duration Resolver for LUSD" });
    expect(region.textContent).not.toMatch(/stale/i);
    expect(screen.queryByText(/Snapshot reason/)).toBeNull();
    expect(region.querySelectorAll("a[href='/stablecoin/lusd-liquity']").length).toBeGreaterThan(0);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(container.querySelector("[data-health-state]")).toBeNull();
  });

  it("keeps retained rows through a failed refresh without a load-error notice", () => {
    vi.useFakeTimers({ now: DDR_TEST_META.computedAt * 1000 + 901_000, toFake: ["setTimeout", "clearTimeout", "Date"] });
    queryMock.mockReturnValue({
      data: { _meta: DDR_TEST_META, rows: [makeFrozenDdrV2Row()] }, error: new Error("HTTP 503"), refetch: vi.fn(),
    });
    const { container } = render(<StablecoinDepegResolverCard stablecoinId="lusd-liquity" />);
    act(() => vi.advanceTimersByTime(0));
    expect(screen.getByRole("region", { name: "Depeg Duration Resolver for LUSD" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    // A failed refresh within the public band is operator signal, not reader copy.
    expect(container.querySelector("[data-health-state]")).toBeNull();
  });

  it("ages retained rows on the producer clock and admits a public notice only past the stale band", () => {
    const computedAt = 1_800_000_000;
    vi.useFakeTimers({ now: computedAt * 1000 + 901_000, toFake: ["setTimeout", "clearTimeout", "Date"] });
    queryMock.mockReturnValue({
      data: { _meta: { ...DDR_TEST_META, computedAt, degraded: true, degradedReason: "stale-cache" }, rows: [makeFrozenDdrV2Row()] },
      error: null, dataUpdatedAt: Date.now(), meta: undefined, refetch: vi.fn(),
    });
    const { container } = render(<StablecoinDepegResolverCard stablecoinId="lusd-liquity" />);
    const banner = () => container.querySelector("[data-health-state]");
    act(() => vi.advanceTimersByTime(0));
    expect(banner()).toBeNull();
    // Exactly 12 x 900 s is still inside the degraded band.
    act(() => vi.advanceTimersByTime(10_800_000 - 901_000));
    expect(banner()).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(banner()?.getAttribute("data-health-state")).toBe("stale");
    expect(screen.getByText("Showing an older snapshot")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Depeg Duration Resolver for LUSD" })).toBeTruthy();
    expect(queryMock.mock.results.at(-1)?.value.refetch).not.toHaveBeenCalled();
  });

  it("keeps an explicit-null producer clock typed unavailable over retained rows", () => {
    queryMock.mockReturnValue({
      data: { _meta: DDR_TEST_META, rows: [makeFrozenDdrV2Row()] }, error: null, refetch: vi.fn(),
      meta: { updatedAt: null, ageSeconds: null, status: "unknown", reason: "missing-producer-clock" },
    });
    const { container } = render(<StablecoinDepegResolverCard stablecoinId="lusd-liquity" />);
    expect(container.querySelector("[data-health-state]")?.getAttribute("data-health-state")).toBe("unavailable");
    expect(screen.getByRole("region", { name: "Depeg Duration Resolver for LUSD" })).toBeTruthy();
  });

  it("outlook leads with verdict and dates snapshot deviation on its own clock", () => {
    const [obs, upd] = [Date.parse("2026-11-24T13:15:00Z") / 1000, Date.parse("2026-11-24T13:28:00Z") / 1000];
    const renderOutlook = (live: Record<string, unknown>) => {
      const row = makeFrozenDdrV2Row();
      row.live = { ...row.live, ...live };
      queryMock.mockReturnValue({ data: { _meta: DDR_TEST_META, rows: [row] }, error: null });
      return { row, view: render(<ActiveDepegOutlook stablecoinId={row.stablecoinId} symbol="LUSD" deviationBps={null} />) };
    };
    const { row, view: a } = renderOutlook({ currentDeviationBps: -4569, currentDeviationObservedAtSec: obs, updatedAt: upd });
    expect(screen.getByRole("heading").textContent).toMatch(/LUSD is trading 45\.7%/);
    expect(a.container.textContent).toContain("Resolver snapshot as of 2026-11-24 13:15 UTC");
    screen.getByText(getTierMeta(getResolution(row).tier, getTierVocabulary(row)).label);
    expect(screen.getByRole("link").getAttribute("href")).toBe("#depeg-resolver");
    a.unmount();

    const { view: b } = renderOutlook({ currentDeviationBps: -4569, updatedAt: upd });
    expect(b.container.textContent).toContain("Resolver snapshot as of 2026-11-24 13:28 UTC");
    b.unmount();

    const { view: c } = renderOutlook({ currentDeviationBps: null, updatedAt: upd });
    expect(screen.getByRole("heading").textContent).toBe("LUSD is off its peg");
    expect(c.container.textContent).not.toContain("Resolver snapshot as of");
  });
});
