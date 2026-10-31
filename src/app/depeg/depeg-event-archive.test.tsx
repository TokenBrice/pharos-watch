import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DepegEventEntry } from "@shared/types/market";

const { EVENTS } = vi.hoisted(() => {
  const base = {
    stablecoinId: "usdc-circle",
    pegType: "USD",
    direction: "below" as const,
    endedAt: 1_784_000_600,
    startPrice: 0.99,
    peakPrice: 0.98,
    recoveryPrice: 1,
    pegReference: 1,
    source: "live" as const,
  };
  return {
    EVENTS: [
      { ...base, id: 1, slug: "disputed-event", stablecoinId: "a7a5-old-vector", symbol: "A7A5", peakDeviationBps: 5_286, startedAt: 1_784_000_000, provenance: { auditVerdict: "disputed" as const } },
      { ...base, id: 2, slug: "false-positive-event", symbol: "EURm", peakDeviationBps: 15_984, startedAt: 1_784_000_000, provenance: { auditVerdict: "false_positive" as const } },
      { ...base, id: 3, slug: "confirmed-event", symbol: "USDC", peakDeviationBps: 1_210, startedAt: 1_784_000_000, provenance: { auditVerdict: "confirmed" as const } },
      { ...base, id: 4, slug: "no-data-event", symbol: "IDRT", peakDeviationBps: 2_000, startedAt: 1_784_000_000, provenance: { auditVerdict: "no_data" as const } },
      { ...base, id: 5, slug: "repaired-event", symbol: "RUSD", peakDeviationBps: 3_000, startedAt: 1_784_000_000, provenance: { auditVerdict: "repaired" as const } },
      { ...base, id: 6, slug: "legacy-event", symbol: "USDT", peakDeviationBps: 1_500, startedAt: 1_784_000_000, provenance: null },
      { ...base, id: 7, slug: "unattributed-event", symbol: "GYD", peakDeviationBps: 1_500, startedAt: 1_784_000_000 },
    ] satisfies readonly DepegEventEntry[],
  };
});

vi.mock("@/lib/depeg-event-page-data", () => ({ DEPEG_EVENT_ENTRIES: EVENTS }));

import { DepegEventArchive, DepegEventArchivePreview } from "./depeg-event-archive";

function rowFor(html: string, slug: string): string {
  const row = html.split("<li>").find((chunk) => chunk.includes(`href="/depeg/${slug}"`));
  expect(row).toBeDefined();
  return row!;
}

describe("depeg event archive audit verdict badge", () => {
  it("badges disputed and false-positive events as Disputed, with no explanatory sub-text", () => {
    const html = renderToStaticMarkup(<DepegEventArchive />);
    for (const slug of ["disputed-event", "false-positive-event"]) {
      const row = rowFor(html, slug);
      expect(row).toContain(">Disputed<");
      expect(row).not.toMatch(/audit|verdict|review/i);
    }
  });

  it("leaves confirmed, no-data, repaired and legacy rows unbadged", () => {
    const html = renderToStaticMarkup(<DepegEventArchive />);
    for (const slug of ["confirmed-event", "no-data-event", "repaired-event", "legacy-event", "unattributed-event"]) {
      expect(rowFor(html, slug)).not.toContain("Disputed");
    }
  });

  it("counts only non-disputed events in the month preview while listing every badged row", () => {
    const html = renderToStaticMarkup(<DepegEventArchivePreview />);
    expect(html).toContain("5 events");
    expect(html).toContain("Browse all 7 event pages");
    for (const slug of ["disputed-event", "false-positive-event", "confirmed-event", "legacy-event"]) {
      expect(rowFor(html, slug)).toBeDefined();
    }
  });

  it("keeps a badged row on one line at 390px", () => {
    const row = rowFor(renderToStaticMarkup(<DepegEventArchive />), "disputed-event");
    // The badge is small and the trailing hint keeps only its arrow below sm.
    expect(row).toContain("text-3xs");
    expect(row).toContain('<span class="hidden sm:inline">View page </span>→');
  });
});
