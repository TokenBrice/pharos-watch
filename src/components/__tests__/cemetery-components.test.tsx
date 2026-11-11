// @vitest-environment jsdom

import { useEffect } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAUSE_META, CAUSE_ORDER } from "@shared/lib/cause-of-death";
import type { CauseOfDeath } from "@shared/lib/cause-of-death";
import { CEMETERY_ENTRIES, type CemeteryEntry } from "@shared/lib/cemetery-merged";
import atlasManifest from "@/lib/cemetery-logo-atlas.generated.json";
import { toPlotLogoAtlas } from "@/lib/cemetery-plot-map-input";
import { buildCemeteryRegisterRows, buildRegisterFilterOptions, type CemeteryRegisterRow } from "@/lib/cemetery-register";
import { buildCemeteryStats, type CemeteryStats, type CemeteryStatsInput } from "@/lib/cemetery-stats";
import { CemeteryCauses } from "../cemetery/cemetery-causes";
import { CemeteryContext } from "../cemetery/cemetery-context";
import { CemeteryHero } from "../cemetery/cemetery-hero";
import { CemeteryKeyFacts } from "../cemetery/cemetery-key-facts";
import { CemeteryRegister } from "../cemetery/cemetery-register";
import { REGISTER_FOLD_COUNT } from "../cemetery/cemetery-register-model";
import {
  CemeterySelectionProvider,
  useCemeterySelection,
  type CemeterySelectionContextValue,
} from "../cemetery/cemetery-selection-context";
import { getPortraitAspectRatio } from "../cemetery/plot-map-portrait-aspect";

// vi.mock factories are hoisted above the imports, so the helper loads lazily inside it.
vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});
vi.mock("@/lib/fonts/digest", () => ({ digestDisplay: { className: "digest-font" } }));

describe("CemeteryCauses", () => {
  // Five records: abandoned leads (2), liquidity drain has none, regulatory has no recorded peak.
  // Recorded peak total $1.2B: abandoned $60M (5%), counterparty $60M (5%), algorithmic $1.08B (90%).
  const ENTRIES: CemeteryStatsInput[] = [
    { id: "abn-1", name: "Abandoned One", symbol: "ABN1", causeOfDeath: "abandoned", deathDate: "2026-08-27", peakMcap: 60e6, pegCurrency: "USD" },
    { id: "abn-2", name: "Abandoned Two", symbol: "ABN2", causeOfDeath: "abandoned", deathDate: "2025-06", peakMcap: null, pegCurrency: "USD" },
    { id: "cpf-1", name: "Counterparty One", symbol: "CPF1", causeOfDeath: "counterparty-failure", deathDate: "2024-01-15", peakMcap: 60e6, pegCurrency: "USD" },
    { id: "alg-1", name: "Algorithmic One", symbol: "ALG1", causeOfDeath: "algorithmic-failure", deathDate: "2022-05-09", peakMcap: 1.08e9, pegCurrency: "USD" },
    { id: "reg-1", name: "Regulatory One", symbol: "REG1", causeOfDeath: "regulatory", deathDate: "2023-02-13", peakMcap: null, pegCurrency: "USD" },
  ];

  function renderCauses() {
    return render(<CemeteryCauses stats={buildCemeteryStats(ENTRIES)} />);
  }

  function column(container: HTMLElement, cause: string): HTMLElement {
    const element = container.querySelector<HTMLElement>(`#cause-${cause}`);
    if (!element) throw new Error(`missing column for ${cause}`);
    return element;
  }

  it("prints every definition, count, share and peak sub-line including unrecorded peaks", () => {
    const { container } = renderCauses();

    for (const cause of CAUSE_ORDER) {
      expect(within(column(container, cause)).getAllByText(CAUSE_META[cause].definition).length).toBeGreaterThan(0);
    }
    // Phrases are separate nowrap runs joined by a non-breaking space and a middle dot.
    const text = (element: HTMLElement) => element.textContent?.replace(/\u00a0/g, " ") ?? "";
    const abandoned = column(container, "abandoned");
    expect(text(abandoned)).toContain("40% of deaths · 5% of recorded peak");
    expect(text(abandoned)).toContain("Median peak $60.0M · largest ABN1 $60.0M · 1 not recorded");

    const regulatory = column(container, "regulatory");
    expect(text(regulatory)).toContain("20% of deaths · peak not recorded");
    expect(text(regulatory)).toContain("No recorded peak · 1 not recorded");
  });

  it("draws both strip rows in the same cause order and names every segment in the aria-label", () => {
    renderCauses();

    const [deaths, peak] = screen.getAllByRole("img");
    const segmentCauses = (bar: HTMLElement) =>
      Array.from(bar.querySelectorAll("[data-cause]"), (segment) => segment.getAttribute("data-cause"));
    expect(segmentCauses(deaths)).toEqual(["abandoned", "counterparty-failure", "algorithmic-failure", "regulatory"]);
    expect(segmentCauses(peak)).toEqual(["abandoned", "counterparty-failure", "algorithmic-failure"]);

    const deathsLabel = deaths.getAttribute("aria-label") ?? "";
    for (const cause of CAUSE_ORDER) expect(deathsLabel).toContain(CAUSE_META[cause].label);
    expect(deathsLabel).toContain("Abandoned 2 (40%)");
    expect(deathsLabel).toContain("Liquidity Drain 0 (0%)");

    const peakLabel = peak.getAttribute("aria-label") ?? "";
    expect(peakLabel).toContain("$1.2B across 3 of 5 records");
    expect(peakLabel).toContain("Algorithmic Failure $1.1B (90%)");
    expect(peakLabel).toContain("Liquidity Drain no records");
    expect(peakLabel).toContain("Regulatory not recorded");
  });
});

describe("CemeteryContext", () => {
  function entry(
    id: string,
    causeOfDeath: CauseOfDeath,
    deathDate: string,
    overrides: Partial<CemeteryEntry> = {},
  ): CemeteryEntry {
    return {
      id,
      name: `Coin ${id}`,
      symbol: id.toUpperCase(),
      pegCurrency: "USD",
      causeOfDeath,
      deathDate,
      peakMcap: 10_000_000,
      obituary: "Obituary.",
      sourceUrl: "https://example.com/",
      sourceLabel: "Example",
      ...overrides,
    };
  }

  function text(html: string): string {
    return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
  }

  // 2018 and 2021–2022 have records; 2019–2020 are empty; 2022 is the partial as-of year.
  const FIXTURE: CemeteryEntry[] = [
    entry("a", "algorithmic-failure", "2018-03", { mechanismArchetype: "algorithmic" }),
    entry("b", "abandoned", "2021-06", { peakMcap: undefined, mechanismArchetype: "cdp" }),
    entry("c", "abandoned", "2021-09-14", { mechanismArchetype: "cdp" }),
    entry("d", "counterparty-failure", "2022-02", { archivedDataAvailable: true }),
    entry("e", "abandoned", "2022-05-02", { archivedDataAvailable: true, peakMcap: undefined }),
    entry("f", "regulatory", "2022-07", { mechanismArchetype: "fiat-cash" }),
  ];

  function renderContext(entries: CemeteryEntry[] = FIXTURE) {
    return renderToStaticMarkup(<CemeteryContext stats={buildCemeteryStats(entries)} caseStudies={[]} />);
  }

  it("templates route, precision, peak and catalog figures from the stats", () => {
    const body = text(renderContext());
    expect(body).toContain("Tracked, then frozen (2)");
    expect(body).toContain("Curated (4)");
    expect(body).toContain("precise to the day for 2 records and to the month for 4");
    expect(body).toContain("2 of 6 not recorded, never counted as zero");
    expect(body).toContain("nothing is recorded for 2019–2020");
    expect(body).toContain("2 of the 3 records in 2022 so far are coins Pharos tracked live");
  });
});

describe("CemeteryHero", () => {
  const rows = buildCemeteryRegisterRows(CEMETERY_ENTRIES);
  const stats = buildCemeteryStats(CEMETERY_ENTRIES);
  const asOf = stats.asOf.date;
  const atlas = toPlotLogoAtlas(atlasManifest);

  beforeEach(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
  });

  function renderHero() {
    const view = render(
      <CemeterySelectionProvider knownIds={rows.map((r) => r.id)}>
        <CemeteryHero rows={rows} stats={stats} asOf={asOf} atlas={atlas} portraitAspectRatio={getPortraitAspectRatio(rows, asOf)} />
      </CemeterySelectionProvider>,
    );
    return { ...view, plan: screen.getByRole("group", { name: "Stablecoin Cemetery plot map" }) };
  }

  it("gives every grave one focusable, uniquely identified element with its full reading", () => {
    const { plan } = renderHero();
    const graves = within(plan).getAllByRole("button");
    const ids = graves.map((g) => g.id);
    expect(ids).toHaveLength(CEMETERY_ENTRIES.length);
    expect(new Set(ids).size).toBe(CEMETERY_ENTRIES.length);
    expect(new Set(ids)).toEqual(new Set(CEMETERY_ENTRIES.map((e) => `grave-${e.id}`)));

    const ust = within(plan).getByRole("button", { name: "TerraUSD (UST), algorithmic failure, died May 2022, peak $18.8B" });
    expect(ust.id).toBe("grave-ust-terrausd-2022-05");
    expect(ust.getAttribute("aria-pressed")).toBe("false");
    expect(ust.getAttribute("href")).toBe("#ust-terrausd-2022-05");
  });

  it("keeps the desktop plan within its 3,500-node budget", () => {
    const { plan } = renderHero();
    expect(plan.querySelectorAll("*").length).toBeLessThanOrEqual(3500);
  });
});

describe("CemeteryKeyFacts", () => {
  const DATASET_META = { schemaVersion: "1.1", sourceChecksumShort: "55a1b478" };

  function makeStats(overrides: Partial<CemeteryStats> = {}, keyFacts: Partial<CemeteryStats["keyFacts"]> = {}): CemeteryStats {
    const base = buildCemeteryStats([
      { id: "a", name: "Coin A", symbol: "AAA", causeOfDeath: "abandoned", deathDate: "2026-08-27", peakMcap: 1e6, pegCurrency: "USD" },
      { id: "b", name: "Coin B", symbol: "BBB", causeOfDeath: "regulatory", deathDate: "2024-03", peakMcap: 2e6, pegCurrency: "USD" },
    ]);
    return {
      ...base,
      asOf: { date: "2026-08-27", year: 2026, month: 8, day: 27, precision: "day", label: "Aug 27, 2026", monthLabel: "Aug 2026" },
      updatedAt: "2026-09-23",
      keyFacts: {
        trailing12: { startMonth: "2025-09", endMonth: "2026-08", months: 12, total: 39, tracked: 20, curated: 19 },
        prior12: { startMonth: "2024-09", endMonth: "2025-08", months: 12, total: 20, tracked: 2, curated: 18 },
        curatedTrend: { trailing: 19, prior: 18, direction: "flat" },
        topTwo: {
          ids: ["busd", "ust"],
          symbols: ["BUSD", "UST"],
          names: ["Binance USD", "TerraUSD"],
          peaks: [23.5e9, 18.7e9],
          sum: 42.2e9,
          share: 0.711,
          recordedTotal: 59.4e9,
          knownCount: 103,
          total: 113,
        },
        medianPeak: { value: 48.8e6, knownCount: 103 },
        atLeastOneBillionCount: 5,
        trackedCount: 24,
        ...keyFacts,
      },
      ...overrides,
    };
  }

  function cellFor(label: string): HTMLElement {
    const cell = screen.getByText(label).parentElement;
    if (!cell) throw new Error(`no cell for ${label}`);
    return cell;
  }

  it("renders the four figures and sub-lines from the stats", () => {
    const { container } = render(<CemeteryKeyFacts stats={makeStats()} datasetMeta={DATASET_META} />);

    expect(screen.getByRole("heading", { level: 2, name: "Key facts" })).toBeTruthy();
    expect(Array.from(container.querySelectorAll("dt"), (dt) => dt.textContent)).toEqual([
      "12 months to Aug 2026",
      "Held by two coins",
      "Median peak",
      "Tracked before death",
    ]);

    const trailing = within(cellFor("12 months to Aug 2026"));
    expect(trailing.getByText("39")).toBeTruthy();
    expect(
      trailing.getByText("20 of these were coins Pharos tracked live (2 in the prior 12 months). Curated records: 19 vs 18."),
    ).toBeTruthy();

    const topTwo = within(cellFor("Held by two coins"));
    expect(topTwo.getByText("71.1%")).toBeTruthy();
    expect(topTwo.getByText("BUSD and UST: $42.2B of $59.4B combined peak (103 of 113 recorded).")).toBeTruthy();

    const median = within(cellFor("Median peak"));
    expect(median.getByText("$48.8M")).toBeTruthy();
    expect(median.getByText("Half of the 103 records with a recorded peak peaked below this. 5 peaked at $1B or more.")).toBeTruthy();

    const tracked = within(cellFor("Tracked before death"));
    expect(tracked.getByText("24")).toBeTruthy();
    expect(
      tracked.getByRole("link", { name: "Show the 24 tracked-archive records in the register" }).getAttribute("href"),
    ).toBe("/cemetery/?record=tracked#register");
  });

  it("names the recorded-peak cohort behind the median, not the whole death population", () => {
    const stats = buildCemeteryStats([
      { id: "a", name: "Coin A", symbol: "AAA", causeOfDeath: "abandoned", deathDate: "2026-08-27", peakMcap: 1e6, pegCurrency: "USD" },
      { id: "b", name: "Coin B", symbol: "BBB", causeOfDeath: "regulatory", deathDate: "2024-03", peakMcap: 2e6, pegCurrency: "USD" },
      { id: "c", name: "Coin C", symbol: "CCC", causeOfDeath: "abandoned", deathDate: "2025-01", peakMcap: undefined, pegCurrency: "USD" },
    ]);
    render(<CemeteryKeyFacts stats={stats} datasetMeta={DATASET_META} />);
    expect(screen.getByText("Half of the 2 records with a recorded peak peaked below this. 0 peaked at $1B or more.")).toBeTruthy();
    expect(screen.queryByText(/Half of the recorded deaths/)).toBeNull();
  });

  it("hides the top-two cell when fewer than two peaks are recorded", () => {
    const { container } = render(<CemeteryKeyFacts stats={makeStats({}, { topTwo: null })} datasetMeta={DATASET_META} />);

    expect(screen.queryByText("Held by two coins")).toBeNull();
    expect(container.querySelectorAll("dt")).toHaveLength(3);
  });

  it("prints a missing median as not recorded, never as zero", () => {
    render(<CemeteryKeyFacts stats={makeStats({}, { medianPeak: { value: null, knownCount: 0 } })} datasetMeta={DATASET_META} />);

    const median = cellFor("Median peak");
    expect(median.textContent).toContain("not recorded");
    expect(median.textContent).not.toContain("$0");
  });

  it("prints the freshness rail without a coverage claim", () => {
    const { container } = render(<CemeteryKeyFacts stats={makeStats()} datasetMeta={DATASET_META} />);

    const rail = container.querySelector("#key-facts p");
    expect(rail?.textContent?.replace(/\u00a0/g, " ")).toBe(
      "Latest record added Sep 23, 2026 · Latest recorded death Aug 27, 2026 · Dataset schema 1.1 · source checksum 55a1b478",
    );
    expect(container.textContent).not.toMatch(/through/i);
  });

  it("omits the latest-record-added clause when no record carries a recordedAt", () => {
    const { container } = render(<CemeteryKeyFacts stats={makeStats({ updatedAt: null })} datasetMeta={DATASET_META} />);

    const rail = container.querySelector("#key-facts p");
    expect(rail?.textContent?.replace(/\u00a0/g, " ")).toBe("Latest recorded death Aug 27, 2026 · Dataset schema 1.1 · source checksum 55a1b478");
    expect(container.textContent).not.toMatch(/through/i);
  });
});

describe("CemeteryRegister", () => {
  const FIXTURE_COUNT = 30;

  /** Strictly newest-first by index: index 0 died Dec 2025, index 12 Dec 2024, … */
  function fixture(index: number): CemeteryEntry {
    const year = 2025 - Math.floor(index / 12);
    const month = String(12 - (index % 12)).padStart(2, "0");
    return {
      id: `coin-${index}`,
      name: `Coin ${index}`,
      symbol: `C${index}`,
      pegCurrency: "USD",
      causeOfDeath: "abandoned",
      deathDate: `${year}-${month}`,
      peakMcap: (index + 1) * 1_000_000,
      epitaph: `Epitaph ${index}`,
      obituary: `Obituary text ${index}.`,
      sourceUrl: `https://example.com/${index}`,
      sourceLabel: `Source ${index}`,
    };
  }

  const OVERRIDES: Record<number, Partial<CemeteryEntry>> = {
    0: { symbol: "USDX", name: "Stables Labs USDX" },
    1: { symbol: "USDX", name: "Kava USDX" },
    2: { causeOfDeath: "regulatory", pegCurrency: "EUR", archivedDataAvailable: true },
    3: { epitaph: "The magic ran out", obituary: "A needle hidden only in the obituary." },
    5: { peakMcap: undefined },
    28: { causeOfDeath: "algorithmic-failure", peakMcap: undefined },
  };

  const ENTRIES: CemeteryEntry[] = Array.from({ length: FIXTURE_COUNT }, (_, index) => ({
    ...fixture(index),
    ...OVERRIDES[index],
  }));
  const ROWS = buildCemeteryRegisterRows(ENTRIES);

  let selection: CemeterySelectionContextValue | null = null;

  function Probe() {
    const value = useCemeterySelection();
    useEffect(() => {
      selection = value;
    });
    return null;
  }

  function Harness({ entries = ENTRIES, rows = ROWS }: { entries?: CemeteryEntry[]; rows?: CemeteryRegisterRow[] }) {
    return (
      <CemeterySelectionProvider knownIds={rows.map((row) => row.id)}>
        <CemeteryRegister rows={rows} filterOptions={buildRegisterFilterOptions(buildCemeteryStats(entries), rows)} />
        <Probe />
      </CemeterySelectionProvider>
    );
  }

  function mainRowIds(root: ParentNode = document): string[] {
    return [...root.querySelectorAll<HTMLTableRowElement>("#register tbody tr[id]:not([data-detail])")].map((row) => row.id);
  }

  function mainRow(id: string): HTMLElement {
    const row = document.getElementById(id);
    if (!row) throw new Error(`no row ${id}`);
    return row;
  }

  function sortHeader(label: string): HTMLElement {
    const header = screen.getByRole("button", { name: `Sort by ${label}` }).closest("th");
    if (!header) throw new Error(`no header ${label}`);
    return header;
  }

  function statusText(): string {
    return document.querySelector("#register p[role='status']")?.textContent ?? "";
  }

  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    selection = null;
    window.history.replaceState(null, "", "/");
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe("server render", () => {
    const realRows = buildCemeteryRegisterRows(CEMETERY_ENTRIES);

    it("renders every record, the first 25 in full and the rest as compact folded rows that work without JS", () => {
      const host = document.createElement("div");
      host.innerHTML = renderToString(<Harness entries={CEMETERY_ENTRIES} rows={realRows} />);

      const main = [...host.querySelectorAll<HTMLTableRowElement>("tr[id]:not([data-detail])")];
      expect(main.map((row) => row.id)).toEqual(realRows.map((row) => row.id));

      const [full, folded] = [main.slice(0, REGISTER_FOLD_COUNT), main.slice(REGISTER_FOLD_COUNT)];
      expect(full.some((row) => row.hasAttribute("data-folded"))).toBe(false);
      for (const row of full) {
        const detail = row.nextElementSibling as HTMLTableRowElement;
        expect(detail.id).toBe(`autopsy-${row.id}`);
        expect(detail.hasAttribute("data-detail") && detail.hidden).toBe(true);
      }
      expect(host.querySelectorAll("tr[data-detail]")).toHaveLength(REGISTER_FOLD_COUNT);

      expect(folded.every((row) => row.hasAttribute("data-folded"))).toBe(true);
      expect(host.querySelectorAll("tr[data-folded]")).toHaveLength(CEMETERY_ENTRIES.length - REGISTER_FOLD_COUNT);
      // A folded record carries its own obituary and source, so `#<id>` shows it through `:target` alone.
      realRows.slice(REGISTER_FOLD_COUNT).forEach((record, index) => {
        const row = folded[index];
        expect(row.querySelectorAll("td")).toHaveLength(1);
        expect(row.textContent).toContain(record.name);
        expect(row.textContent).toContain(record.obituary);
        expect(row.querySelector(`a[href="${record.sourceUrl}"]`)).not.toBeNull();
      });

      expect(host.querySelector("#register")?.hasAttribute("data-enhanced")).toBe(false);
    });

    it("links tracked archive names to their profile in the static HTML, full and folded rows alike", () => {
      const host = document.createElement("div");
      host.innerHTML = renderToString(<Harness entries={CEMETERY_ENTRIES} rows={realRows} />);

      const tracked = realRows.filter((row) => row.tracked);
      expect(tracked.length).toBeGreaterThan(0);
      for (const row of realRows) {
        const link = host.querySelector(`tr[id="${row.id}"] a[href^="/stablecoin/${row.id}"]`);
        expect(link !== null, row.id).toBe(row.tracked);
        if (link) expect(link.textContent).toBe(row.name);
      }
    });

    it("hydrates the static HTML without a mismatch, then applies the URL filters", async () => {
      // The static export renders unfiltered; the browser URL only applies after hydration.
      window.history.replaceState(null, "", "/cemetery/?cause=regulatory");
      const element = <Harness />;
      const container = document.createElement("div");
      container.innerHTML = renderToString(element);
      expect(mainRowIds(container)).toHaveLength(FIXTURE_COUNT);

      const errors: unknown[] = [];
      const root = hydrateRoot(container, element, { onRecoverableError: (error) => errors.push(error) });
      try {
        await waitFor(() => expect(mainRowIds(container)).toEqual(["coin-2"]));
        expect(errors).toEqual([]);
        expect(container.querySelector("#register")?.hasAttribute("data-enhanced")).toBe(true);
      } finally {
        await act(() => root.unmount());
      }
    });
  });

  it("reveals a folded record: clears the filters that exclude it, unfolds, expands and focuses", () => {
    window.history.replaceState(null, "", "/cemetery/?cause=regulatory&foo=bar");
    render(<Harness />);
    expect(mainRowIds()).toEqual(["coin-2"]);

    act(() => selection!.revealRecord("coin-28", "hash"));

    expect(window.location.search).toBe("?foo=bar");
    expect(window.location.hash).toBe("#coin-28");
    expect(mainRowIds()).toHaveLength(FIXTURE_COUNT);
    expect(mainRow("coin-28").hasAttribute("data-folded")).toBe(false);
    expect((document.getElementById("autopsy-coin-28") as HTMLTableRowElement).hidden).toBe(false);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close autopsy for Coin 28 (C28)");
    expect(mainRow("coin-28").scrollIntoView).toHaveBeenCalled();
    expect(statusText()).toBe("Filters cleared to show C28.");
  });

  it("exposes the sort on the headers and keeps unrecorded peaks last in both directions", () => {
    render(<Harness />);
    expect(sortHeader("Died").getAttribute("aria-sort")).toBe("descending");
    expect(sortHeader("Peak market cap").getAttribute("aria-sort")).toBe("none");

    fireEvent.click(screen.getByRole("button", { name: "Sort by Peak market cap" }));
    expect(sortHeader("Peak market cap").getAttribute("aria-sort")).toBe("descending");
    expect(sortHeader("Died").getAttribute("aria-sort")).toBe("none");
    expect(new URLSearchParams(window.location.search).get("sort")).toBe("peak");
    expect(mainRowIds()[0]).toBe("coin-29");
    expect(mainRowIds().slice(-2)).toEqual(["coin-5", "coin-28"]);

    fireEvent.click(screen.getByRole("button", { name: "Sort by Peak market cap" }));
    expect(sortHeader("Peak market cap").getAttribute("aria-sort")).toBe("ascending");
    expect(mainRowIds()[0]).toBe("coin-0");
    expect(mainRowIds().slice(-2)).toEqual(["coin-5", "coin-28"]);
  });

  it("counts filtered matches against the register total without claiming the total matched", () => {
    window.history.replaceState(null, "", "/cemetery/?cause=regulatory");
    render(<Harness />);
    expect(screen.getByText("Showing 1 matching of 30 records")).toBeDefined();
    expect(screen.queryByText("Showing 1 of 30 matching")).toBeNull();
  });

  it.each([false, true])("debounces counts without overwriting a later reveal (reveal=%s)", (reveal) => {
    vi.useFakeTimers();
    try {
      window.history.replaceState(null, "", "/cemetery/?q=USDX");
      render(<Harness />);
      act(() => vi.advanceTimersByTime(300));
      expect(statusText()).toBe("");

      fireEvent.change(screen.getByRole("textbox"), { target: { value: "C2" } });
      const opened = "Opened autopsy for Coin 2 (C2).";
      if (reveal) act(() => selection!.revealRecord("coin-2", "chart"));
      act(() => vi.advanceTimersByTime(299));
      expect(statusText()).toBe(reveal ? opened : "");
      act(() => vi.advanceTimersByTime(1));
      expect(statusText()).toBe(reveal ? opened : "Showing 11 matching of 30 records.");
      act(() => vi.advanceTimersByTime(1200));
      expect(statusText()).toBe(reveal ? opened : "Showing 11 matching of 30 records.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("prints the shared peg label instead of the raw peg enum", () => {
    const entries: CemeteryEntry[] = [
      { ...fixture(0), id: "peg-var", pegCurrency: "VAR" },
      { ...fixture(1), id: "peg-other", pegCurrency: "OTHER" },
    ];
    render(<Harness entries={entries} rows={buildCemeteryRegisterRows(entries)} />);

    const varRow = mainRow("peg-var");
    expect(within(varRow).getByText("CPI")).toBeTruthy();
    expect(within(varRow).queryByText("VAR")).toBeNull();
    expect(within(mainRow("peg-other")).getByText("Other")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open autopsy for Coin 0 (C0)" }));
    const autopsy = document.getElementById("autopsy-peg-var")!;
    expect(within(autopsy).getByText("CPI")).toBeTruthy();
    expect(within(autopsy).queryByText("VAR")).toBeNull();
  });

  it("prints the derived facts in an expanded autopsy", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open autopsy for Coin 2 (C2)" }));
    const autopsy = document.getElementById("autopsy-coin-2") as HTMLTableRowElement;

    expect(within(autopsy).getByText("Regulatory")).toBeTruthy();
    expect(within(autopsy).getByText("Oct 2025")).toBeTruthy();
    expect(within(autopsy).getByText("(month precision)")).toBeTruthy();
    expect(within(autopsy).getByText("$3.0M")).toBeTruthy();
    expect(within(autopsy).getByText("Tracked archive: frozen detail page")).toBeTruthy();
    expect(within(autopsy).getByRole("link", { name: /Archived data/ }).getAttribute("href")).toBe("/stablecoin/coin-2/");
  });

  it("activates rows only for plain primary clicks, ignoring selections elsewhere on the page", () => {
    render(<Harness />);
    const row = mainRow("coin-2");
    const autopsy = document.getElementById("autopsy-coin-2") as HTMLTableRowElement;
    const modifiers = [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { button: 2 }];
    for (const options of modifiers) {
      fireEvent.click(row, options);
      expect(autopsy.hidden).toBe(true);
    }
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(screen.getByRole("heading", { name: "Every documented death" }));
    selection.addRange(range);
    try {
      fireEvent.click(row);
      expect(autopsy.hidden).toBe(false);
      selection.removeAllRanges();
      range.selectNodeContents(within(row).getByText("Coin 2"));
      selection.addRange(range);
      fireEvent.click(row);
      expect(autopsy.hidden).toBe(false);
    } finally {
      selection.removeAllRanges();
    }
  });
});
