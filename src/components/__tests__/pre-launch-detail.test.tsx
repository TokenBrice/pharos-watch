// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types";
import { PreLaunchDetail } from "@/components/pre-launch-detail";

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
  launchPhaseDetail: "The complete dated launch narrative remains available before live tracking begins.",
  milestones: [{ date: "2026-09-01", type: "milestone", title: "Deployment announced", description: "A long deployment address remains readable." }],
};

describe("PreLaunchDetail", () => {
  it("puts identity first and retains the complete narrative in a closed native disclosure", () => {
    const html = renderToStaticMarkup(<PreLaunchDetail coin={coin} logoSrc={undefined} summary={null} logos={{}} />);
    const document = new DOMParser().parseFromString(html, "text/html");
    const heading = document.querySelector("h1");
    const disclosure = document.querySelector("details");

    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(heading?.textContent).toBe("Test Launch (TEST) Pre-launch Stablecoin Tracker");
    expect(heading!.compareDocumentPosition(disclosure!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(disclosure?.hasAttribute("open")).toBe(false);
    expect(disclosure?.querySelector("summary")?.textContent).toBe("Full launch status and history");
    expect(disclosure?.querySelector("p")?.textContent).toBe(coin.launchPhaseDetail);
    expect(disclosure?.querySelector("p")?.classList.contains("break-words")).toBe(true);
    expect([...document.querySelectorAll("p")].find((p) => p.textContent === coin.milestones![0].description)?.classList.contains("break-words")).toBe(true);
    expect(document.body.textContent).toContain("Pharos hasn't ingested data for this one yet.");
    expect(document.body.textContent).toContain("/subscribe launch test-launch");
    expect(document.querySelector("code")?.tabIndex).toBe(0);
    expect(document.body.textContent).toContain("Get a Telegram alert when TEST becomes tracked on Pharos");
  });

  it("omits the disclosure when no launch narrative is available", () => {
    const html = renderToStaticMarkup(
      <PreLaunchDetail coin={{ ...coin, launchPhaseDetail: undefined }} logoSrc={undefined} summary={null} logos={{}} />,
    );
    expect(html).not.toContain("<details");
    expect(html).toContain("Pre-launch Stablecoin Tracker");
  });
  it("computes launch progress from the browser date instead of the build date", () => {
    vi.useFakeTimers();
    const timelineCoin = {
      ...coin,
      announcedDate: "2026-01-01",
      expectedLaunchDate: "2027-01-01",
    };

    vi.setSystemTime(new Date("2026-04-01T00:00:00Z"));
    const first = render(<PreLaunchDetail coin={timelineCoin} logoSrc={undefined} summary={null} logos={{}} />);
    const firstProgress = Number((first.getByRole("progressbar").firstElementChild as HTMLElement).style.width.slice(0, -1));
    first.unmount();

    vi.setSystemTime(new Date("2026-04-02T00:00:00Z"));
    const second = render(<PreLaunchDetail coin={timelineCoin} logoSrc={undefined} summary={null} logos={{}} />);
    const secondProgress = Number((second.getByRole("progressbar").firstElementChild as HTMLElement).style.width.slice(0, -1));
    expect(secondProgress).toBeGreaterThan(firstProgress);
    vi.useRealTimers();
  });

});
