// @vitest-environment jsdom

import { useEffect } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CEMETERY_ENTRIES, type CemeteryEntry } from "@shared/lib/cemetery-merged";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { copyText } from "@/lib/clipboard";
import { buildCemeteryRegisterRows, buildRegisterFilterOptions, type CemeteryRegisterRow } from "@/lib/cemetery-register";
import { buildCemeteryStats } from "@/lib/cemetery-stats";
import { CemeteryRegister } from "../cemetery/cemetery-register";
import { REGISTER_FOLD_COUNT, sortRegisterRows } from "../cemetery/cemetery-register-model";
import {
  CemeterySelectionProvider,
  useCemeterySelection,
  type CemeterySelectionContextValue,
} from "../cemetery/cemetery-selection-context";

// vi.mock factories are hoisted above the imports, so the helper loads lazily inside it.
vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

vi.mock("@/lib/fonts/digest", () => ({ digestDisplay: { className: "digest-font" } }));

vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(async () => ({ ok: true })) }));

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
const IDS = ROWS.map((row) => row.id);

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

describe("CemeteryRegister server render", () => {
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

describe("CemeteryRegister", () => {
  it("applies filters read from the URL and shows every match", () => {
    window.history.replaceState(null, "", "/cemetery/?cause=regulatory&year=2025");
    render(<Harness />);

    expect(mainRowIds()).toEqual(["coin-2"]);
    expect(document.querySelectorAll("#register tr[data-folded]")).toHaveLength(0);
    expect(screen.getByText(`Showing 1 of ${FIXTURE_COUNT} matching`)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Regulatory/ }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByRole("combobox", { name: /Year/ }) as HTMLSelectElement).value).toBe("2025");
  });

  it("searches name, ticker, id and epitaph but not the obituary", () => {
    window.history.replaceState(null, "", "/cemetery/?q=magic%20ran");
    const { unmount } = render(<Harness />);
    expect(mainRowIds()).toEqual(["coin-3"]);
    unmount();

    window.history.replaceState(null, "", "/cemetery/?q=needle");
    render(<Harness />);
    expect(mainRowIds()).toEqual([]);
    expect(screen.getByText("No records match these filters.")).toBeTruthy();
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

  it("reveals a compact folded record without filters by showing every record in full", () => {
    render(<Harness />);
    expect(mainRow("coin-27").hasAttribute("data-folded")).toBe(true);
    expect(document.getElementById("autopsy-coin-27")).toBeNull();

    act(() => selection!.revealRecord("coin-27", "chart"));

    expect(document.querySelectorAll("#register tr[data-folded]")).toHaveLength(0);
    expect(screen.getByText(`All ${FIXTURE_COUNT} records shown.`, { exact: false })).toBeTruthy();
    expect((document.getElementById("autopsy-coin-27") as HTMLTableRowElement).hidden).toBe(false);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close autopsy for Coin 27 (C27)");
    expect(statusText()).toBe("Opened autopsy for Coin 27 (C27).");
  });

  it("shows every record from the fold row and moves focus to the first one it revealed", () => {
    render(<Harness />);
    expect(screen.getByText(`${FIXTURE_COUNT - REGISTER_FOLD_COUNT} more records below the first 25.`)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: `Show all ${FIXTURE_COUNT} records` }));

    expect(document.querySelectorAll("#register tr[data-folded]")).toHaveLength(0);
    expect(screen.getByText(`Showing ${FIXTURE_COUNT} of ${FIXTURE_COUNT}`)).toBeTruthy();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Open autopsy for Coin 25 (C25)");
  });

  it("names both coins that share a ticker", () => {
    render(<Harness />);
    expect(within(mainRow("coin-0")).getByText("Stables Labs USDX")).toBeTruthy();
    expect(within(mainRow("coin-1")).getByText("Kava USDX")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open autopsy for Stables Labs USDX (USDX)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open autopsy for Kava USDX (USDX)" })).toBeTruthy();
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

  it("expands a row into its autopsy and copies the canonical record link", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open autopsy for Coin 3 (C3)" }));

    expect(window.location.hash).toBe("#coin-3");
    const autopsy = document.getElementById("autopsy-coin-3") as HTMLTableRowElement;
    expect(autopsy.hidden).toBe(false);
    expect(within(autopsy).getByText("Autopsy · Coin 3 (C3)")).toBeTruthy();

    await act(async () => {
      fireEvent.click(within(autopsy).getByRole("button", { name: "Copy link" }));
    });
    expect(copyText).toHaveBeenCalledWith(`${SITE_ORIGIN}/cemetery/#coin-3`);
    expect(within(autopsy).getByRole("button", { name: "Link copied" })).toBeTruthy();
    expect(within(autopsy).getByRole("status").textContent).toBe("Link copied.");
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
});

describe("sortRegisterRows", () => {
  const byPeak = (dir: "asc" | "desc") => sortRegisterRows(ROWS, { key: "peak", dir }).map((row) => row.peak);

  it("sorts unrecorded peaks after every recorded peak in both directions", () => {
    for (const dir of ["asc", "desc"] as const) {
      const peaks = byPeak(dir);
      const firstUnknown = peaks.indexOf(null);
      expect(peaks.slice(firstUnknown).every((peak) => peak === null)).toBe(true);
      expect(peaks.slice(0, firstUnknown).every((peak) => peak !== null)).toBe(true);
    }
  });

  it("orders Died by the shared cemetery order in each direction", () => {
    expect(sortRegisterRows(ROWS, { key: "died", dir: "desc" }).map((row) => row.id)).toEqual(IDS);
    expect(sortRegisterRows(ROWS, { key: "died", dir: "asc" }).map((row) => row.id)).toEqual([...IDS].reverse());
  });
});
