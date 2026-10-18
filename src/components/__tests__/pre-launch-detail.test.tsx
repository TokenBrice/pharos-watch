// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types";
import { PreLaunchDetail } from "@/components/pre-launch-detail";
import { DRIFT_STATUS_LABEL, resolveDriftDisplay } from "@/lib/pre-launch";

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

describe("PreLaunchDetail", () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); });

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
    vi.useFakeTimers({ toFake: ["Date"] });
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
});
