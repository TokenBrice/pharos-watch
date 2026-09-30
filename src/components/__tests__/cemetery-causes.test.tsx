// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CAUSE_META, CAUSE_ORDER } from "@shared/lib/cause-of-death";
import { buildRegisterHref } from "@/lib/cemetery-selection";
import { buildCemeteryStats, type CemeteryStatsInput } from "@/lib/cemetery-stats";
import { CemeteryCauses } from "../cemetery/cemetery-causes";

// vi.mock factories are hoisted above the imports, so the helper loads lazily inside it.
vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

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

describe("CemeteryCauses", () => {
  it("renders one anchored column per cause in CAUSE_ORDER, zero-count causes included", () => {
    const { container } = renderCauses();

    const columns = Array.from(container.querySelectorAll<HTMLElement>("#causes li[id]"));
    expect(columns.map((li) => li.id)).toEqual([
      "cause-abandoned",
      "cause-counterparty-failure",
      "cause-liquidity-drain",
      "cause-algorithmic-failure",
      "cause-regulatory",
    ]);
    expect(columns.map((li) => within(li).getByRole("heading", { level: 3 }).textContent)).toEqual(
      CAUSE_ORDER.map((cause) => CAUSE_META[cause].label),
    );
    expect(column(container, "liquidity-drain").textContent).toContain("No records");
  });

  it("prints every definition, count, share and peak sub-line including unrecorded peaks", () => {
    const { container } = renderCauses();

    for (const cause of CAUSE_ORDER) {
      expect(within(column(container, cause)).getAllByText(CAUSE_META[cause].definition).length).toBeGreaterThan(0);
    }
    const abandoned = column(container, "abandoned");
    expect(abandoned.textContent).toContain("40% of deaths · 5% of recorded peak");
    expect(within(abandoned).getByText("Median peak $60.0M · largest ABN1 $60.0M · 1 not recorded")).toBeTruthy();

    const regulatory = column(container, "regulatory");
    expect(regulatory.textContent).toContain("20% of deaths · peak not recorded");
    expect(within(regulatory).getByText("No recorded peak · 1 not recorded")).toBeTruthy();
  });

  it("links each cause with records to its register filter", () => {
    const { container } = renderCauses();

    expect(within(column(container, "abandoned")).getByRole("link", { name: "Show 2 in the register" }).getAttribute("href")).toBe(
      buildRegisterHref({ cause: "abandoned" }),
    );
    expect(
      within(column(container, "counterparty-failure")).getByRole("link", { name: "Show 1 in the register" }).getAttribute("href"),
    ).toBe(buildRegisterHref({ cause: "counterparty-failure" }));
    expect(within(column(container, "liquidity-drain")).queryByRole("link")).toBeNull();

    const algorithmic = within(column(container, "algorithmic-failure"));
    expect(algorithmic.getByRole("link", { name: "Show 1 in the register" }).getAttribute("href")).toBe(
      buildRegisterHref({ cause: "algorithmic-failure" }),
    );
    expect(algorithmic.getByRole("link", { name: /How algorithmic designs fail/ }).getAttribute("href")).toBe(
      "/learn/mechanisms/algorithmic/",
    );
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

  it("shows the abandonment pattern headline with its register link", () => {
    renderCauses();

    expect(screen.getByText("Abandonment is the most common cause")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Show these records in the register" }).getAttribute("href")).toBe(
      buildRegisterHref({ cause: "abandoned" }),
    );
  });
});
