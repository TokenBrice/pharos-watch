// @vitest-environment jsdom

import { hydrateRoot } from "react-dom/client";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types";
import { PreLaunchDetail } from "@/components/pre-launch-detail";
import { PreLaunchReadiness, usePreLaunchNowMs } from "@/components/pre-launch-readiness";
import { PreLaunchLaunchPath } from "@/components/pre-launch-launch-path";
import { resolveDriftDisplay } from "@/lib/pre-launch";
import { DRIFT_STATUS_LABEL } from "@shared/lib/classification/pre-launch";

const coin: StablecoinMeta = {
  id: "test-launch",
  name: "Test Launch",
  symbol: "TEST",
  status: "pre-launch",
  flags: {
    governance: "centralized",
    backing: "rwa-backed",
    pegCurrency: "USD",
    yieldBearing: false,
    rwa: true,
    navToken: false,
  },
  launchPhase: "testnet",
  announcedDate: "2026-01-01",
  expectedLaunchDate: "2026-Q4",
  dateHistory: [{ date: "2026-Q2", setOn: "2026-03-22" }],
  launchPhaseDetail: "The complete dated launch narrative remains available before live tracking begins.",
  milestones: [
    { date: "2026-09-01", type: "milestone", title: "Deployment announced", description: "A long deployment address remains readable." },
    ...Array.from({ length: 6 }, (_, i) => ({
      date: `2026-0${i + 1}-15`,
      type: "partnership" as const,
      title: `Partner ${i + 1}`,
      sourceUrl: `https://example.com/${i + 1}` as const,
    })),
  ],
};

function staticDocument(input: StablecoinMeta = coin) {
  const html = renderToStaticMarkup(<PreLaunchDetail coin={input} logoSrc={undefined} summary={null} />);
  return new DOMParser().parseFromString(html, "text/html");
}

function ClockSurfaces({ input }: { input: StablecoinMeta }) {
  return <><PreLaunchReadiness coin={input} /><PreLaunchLaunchPath coin={input} /></>;
}

describe("PreLaunchDetail", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it("uses the dossier identity header and keeps the launch narrative in a closed module fold", () => {
    const document = staticDocument();
    const heading = document.querySelector("h1");
    const narrative = document.getElementById("launch-status");

    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(heading?.textContent).toBe("Test Launch (TEST) pre-launch stablecoin tracker");
    expect(narrative?.tagName).toBe("DETAILS");
    expect(narrative?.hasAttribute("open")).toBe(false);
    expect(narrative?.hasAttribute("data-module-fold")).toBe(true);
    expect(narrative?.querySelector("summary")?.textContent).toBe("Launch status narrative");
    expect(narrative?.querySelector("p")?.textContent).toBe(coin.launchPhaseDetail);
    expect(narrative?.querySelector("p")?.classList.contains("break-words")).toBe(true);
    // Every fold is a ModuleDisclosure: no bare native details triangles.
    for (const details of document.querySelectorAll("details")) {
      expect(details.hasAttribute("data-module-fold")).toBe(true);
    }
    expect([...document.querySelectorAll("p")].find((p) => p.textContent === coin.milestones![0].description)?.classList.contains("break-words")).toBe(true);
  });

  it("states live surfaces as one explicit absence strip and shows no market figures", () => {
    const document = staticDocument();
    const strip = document.querySelector('[data-evidence-state="pending-launch"]');
    expect(strip?.textContent).toContain("Live surfaces");
    expect(strip?.textContent).toContain("Activates at launch");
    expect(document.body.textContent).not.toMatch(/\$\d/);
  });

  it("keeps the exact per-asset launch command in the server-rendered alert action", () => {
    const document = staticDocument();
    const trigger = document.querySelector('[aria-label^="Launch alert"]');
    expect(trigger?.getAttribute("aria-label")).toBe("Launch alert: send /subscribe launch test-launch to @PharosWatchBot");
  });

  it("folds activity beyond the newest five and keeps per-milestone sources", () => {
    const document = staticDocument();
    const earlier = document.getElementById("earlier-activity");
    expect(earlier?.querySelector("summary")?.textContent).toBe("Earlier activity (2)");
    expect(document.getElementById("activity")?.textContent).toContain("7 entries · 6 sourced");
    expect(document.querySelectorAll('#activity a[href^="https://example.com/"]')).toHaveLength(6);
    expect(document.getElementById("target-history")?.textContent).toContain("Q2 2026");
    expect(document.getElementById("target-history")?.textContent).toContain("retired Mar 22, 2026");
  });

  it("renders registry facts only when the target and phase are missing", () => {
    const document = staticDocument({ ...coin, launchPhase: undefined, expectedLaunchDate: undefined, dateHistory: undefined });
    const readiness = document.querySelector('[aria-label="Launch readiness"]');
    expect(readiness?.textContent).toContain("Unphased");
    expect(readiness?.textContent).toContain("No target date");
    expect(readiness?.textContent).toContain("Nothing to drift from");
  });

  it("states a retired target neutrally instead of treating it as a live drift", () => {
    const document = staticDocument({ ...coin, expectedLaunchDate: undefined });
    const readiness = document.querySelector('[aria-label="Launch readiness"]');
    expect(readiness?.textContent).toContain(DRIFT_STATUS_LABEL[resolveDriftDisplay("pushed-once", undefined)]);
    expect(readiness?.textContent).toContain("Q2 2026 target retired Mar 22, 2026");
    expect(readiness?.textContent).toContain("Earlier target retired");
    expect(readiness?.textContent).not.toMatch(/withdrawn/i);
    expect(document.getElementById("launch-path")?.textContent).toContain("earlier target retired, none set");
  });

  it("server-renders no clock-derived text", () => {
    const text = staticDocument().body.textContent ?? "";
    expect(text).not.toMatch(/Window (opens|open|closed)|\d+ d ago|\bIn \d+ d\b/);
    for (const label of ["On track", "Pushed once", "Delayed", "Overdue"]) expect(text).not.toContain(label);
    expect(text).not.toMatch(/~?\d[\d,]* ?d\b/);
  });

  it("reads the readiness clock from the browser, not the build", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
    const first = render(<PreLaunchDetail coin={coin} logoSrc={undefined} summary={null} />);
    expect(screen.getByText("Window opens in 6 d")).toBeTruthy();
    expect(screen.getByText("Pushed once")).toBeTruthy();
    expect(screen.getByRole("img", { name: /TEST launch path/ })).toBeTruthy();
    first.unmount();

    vi.setSystemTime(new Date("2027-01-03T12:00:00Z"));
    render(<PreLaunchDetail coin={coin} logoSrc={undefined} summary={null} />);
    expect(screen.getByText("Window closed 2 d ago")).toBeTruthy();
    expect(screen.getByText("Overdue")).toBeTruthy();
  });

  it.each(["2026-09-30", "2026-09", "2026-Q3"])("expires the inclusive %s target and advances both mounted surfaces at UTC midnight", (target) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T23:59:00Z"));
    const input = { ...coin, expectedLaunchDate: target, dateHistory: undefined, announcedDate: "2026-09-29" };
    const mounted = render(<ClockSurfaces input={input} />);
    const age = screen.getByText("Since announcement").parentElement!;
    const today = screen.getByText("Today · Testnet");
    const position = today.getAttribute("style");
    expect(screen.getByText("On track")).toBeTruthy();
    // The path also labels today's target; the countdown belongs to readiness.
    expect(within(screen.getByRole("group", { name: "Launch readiness" }))
      .getByText(target === "2026-09-30" ? "Today" : "Window open · closes in 1 d")).toBeTruthy();
    expect(age.textContent).toContain("1d");
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(59_999));
    expect(screen.queryByText("Overdue")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText("Overdue")).toBeTruthy();
    expect(screen.getByText(target === "2026-09-30" ? "Passed 0 d ago" : "Window closed 0 d ago")).toBeTruthy();
    expect(age.textContent).toContain("2d");
    expect(today.getAttribute("style")).not.toBe(position);
    mounted.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes the shared visibility listener only when the last consumer unmounts", () => {
    vi.useFakeTimers();
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    const first = render(<ClockSurfaces input={coin} />);
    const second = render(<ClockSurfaces input={coin} />);
    const subscriptions = add.mock.calls.filter(([event]) => event === "visibilitychange");
    expect(subscriptions).toHaveLength(1);
    first.unmount();
    expect(remove.mock.calls.filter(([event]) => event === "visibilitychange")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1);
    second.unmount();
    expect(remove).toHaveBeenCalledWith("visibilitychange", subscriptions[0][1]);
    expect(vi.getTimerCount()).toBe(0);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resumes from a suspended tab and keeps aging after the target expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T23:59:00Z"));
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    render(<ClockSurfaces input={{ ...coin, expectedLaunchDate: "2026-09", dateHistory: undefined, announcedDate: "2026-09-29" }} />);
    const today = screen.getByText("Today · Testnet");
    const position = today.getAttribute("style");
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(screen.getByText("Overdue")).toBeTruthy();
    expect(screen.getByText("Window closed 2 d ago")).toBeTruthy();
    expect(screen.getByText("Since announcement").parentElement?.textContent).toContain("4d");
    expect(today.getAttribute("style")).not.toBe(position);
    act(() => vi.advanceTimersByTime(12 * 60 * 60_000));
    expect(screen.getByText("Window closed 3 d ago")).toBeTruthy();
    expect(screen.getByText("Since announcement").parentElement?.textContent).toContain("5d");
  });

  it("retains null on the server and first hydration even when another clock consumer is mounted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T23:59:00Z"));
    render(<ClockSurfaces input={coin} />);
    const snapshots: (number | null)[] = [];
    function HydratedSurfaces() {
      snapshots.push(usePreLaunchNowMs());
      return <ClockSurfaces input={coin} />;
    }
    const container = document.createElement("div");
    container.innerHTML = renderToString(<HydratedSurfaces />);
    expect(snapshots).toEqual([null]);
    expect(container.textContent).not.toContain("Pushed once");
    expect(container.querySelector('[role="img"]')).toBeNull();
    snapshots.length = 0;
    const errors: unknown[] = [];
    const root = hydrateRoot(container, <HydratedSurfaces />, { onRecoverableError: (error) => errors.push(error) });
    try {
      await act(async () => {});
      expect(snapshots[0]).toBeNull();
      expect(snapshots.at(-1)).toBe(Date.now());
      expect(container.textContent).toContain("Pushed once");
      expect(container.querySelector('[role="img"]')).not.toBeNull();
      expect(errors).toEqual([]);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      await act(() => root.unmount());
    }
  });
});
