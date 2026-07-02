import { describe, it, expect } from "vitest";
import {
  digestPage,
  mergeDigestedPages,
  type DigestedDay,
} from "@/lib/tape-digest";
import type { TapeEvent, TapeEventSeverity } from "@shared/types/tape-event";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const MS_PER_HOUR = 3_600_000;
// Pick `nowMs` deep inside a UTC day so the "today"/"yesterday" boundaries
// don't shift when we offset events by a few hours.
const NOW_MS = Date.UTC(2026, 4, 21, 12, 0, 0); // 2026-05-21 12:00:00Z
const TODAY_KEY = "2026-05-21";
const YESTERDAY_KEY = "2026-05-20";
const TWO_DAYS_AGO_KEY = "2026-05-19";

let idSeq = 0;
function makeEvent(
  ts: number,
  type: string,
  overrides: Partial<TapeEvent> = {},
): TapeEvent {
  idSeq += 1;
  return {
    id: `ev-${idSeq}`,
    type,
    severity: "info" as TapeEventSeverity,
    ts,
    endsAt: null,
    coinId: "usdc",
    issuerId: null,
    pegCurrency: null,
    chain: null,
    title: "",
    summary: "",
    payload: {},
    sourceTable: "test",
    sourceRowId: `row-${idSeq}`,
    transition: "snapshot",
    sourceUrl: null,
    methodologyVersion: null,
    ...overrides,
  };
}

/** Sort events ts desc (mirrors the API's ordering). */
function sortDesc(events: TapeEvent[]): TapeEvent[] {
  return [...events].sort((a, b) => b.ts - a.ts);
}

function digestByDayForTest(events: readonly TapeEvent[], nowMs: number): DigestedDay[] {
  return mergeDigestedPages([digestPage(events, nowMs)]);
}

// ---------------------------------------------------------------------------
// single-page digest
// ---------------------------------------------------------------------------

describe("single-page digest", () => {
  it("buckets events by UTC day, newest day first", () => {
    const events = sortDesc([
      makeEvent(NOW_MS - MS_PER_HOUR, "depeg.opened"),
      makeEvent(NOW_MS - 25 * MS_PER_HOUR, "depeg.opened"),
      makeEvent(NOW_MS - 50 * MS_PER_HOUR, "depeg.opened"),
    ]);
    const days = digestByDayForTest(events, NOW_MS);
    expect(days.map((d) => d.dayKey)).toEqual([
      TODAY_KEY,
      YESTERDAY_KEY,
      TWO_DAYS_AGO_KEY,
    ]);
    expect(days[0]!.isToday).toBe(true);
    expect(days[1]!.isYesterday).toBe(true);
    expect(days[2]!.isToday).toBe(false);
    expect(days[2]!.isYesterday).toBe(false);
  });

  it("returns empty array for empty input", () => {
    expect(digestByDayForTest([], NOW_MS)).toEqual([]);
  });

  it("sets useDigestWrapper at the digest threshold", () => {
    const events = sortDesc([
      makeEvent(NOW_MS - 1, "depeg.opened", { coinId: "a" }),
      makeEvent(NOW_MS - 2, "depeg.opened", { coinId: "b" }),
      makeEvent(NOW_MS - 3, "depeg.opened", { coinId: "c" }),
    ]);
    const [today] = digestByDayForTest(events, NOW_MS);
    const depegClass = today!.classes.find((c) => c.classSlug === "depeg")!;
    expect(depegClass.rawCount).toBe(3);
    expect(depegClass.useDigestWrapper).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// class summaries
// ---------------------------------------------------------------------------

describe("yield class summary", () => {
  it("reports the worst PYS drop from projector-style positive deltas", () => {
    const events = sortDesc([
      makeEvent(NOW_MS - 1, "yield.warning_emitted", { coinId: "usdt" }),
      makeEvent(NOW_MS - 2, "yield.pys_dropped", {
        coinId: "usdt",
        payload: { delta: 12 },
      }),
      makeEvent(NOW_MS - 3, "yield.pys_dropped", {
        coinId: "usdt",
        payload: { delta: 25 },
      }),
    ]);

    const [today] = digestByDayForTest(events, NOW_MS);
    const yieldClass = today!.classes.find((c) => c.classSlug === "yield")!;

    expect(yieldClass.summary).toBe("1 warning · 2 PYS drops · worst -25 pts · usdt ×3");
  });

  it("keeps rendering legacy signed negative PYS deltas as drops", () => {
    const events = sortDesc([
      makeEvent(NOW_MS - 1, "yield.pys_dropped", {
        coinId: "usdt",
        payload: { delta: -18 },
      }),
    ]);

    const [today] = digestByDayForTest(events, NOW_MS);
    const yieldClass = today!.classes.find((c) => c.classSlug === "yield")!;

    expect(yieldClass.summary).toBe("1 PYS drop · worst -18 pts · usdt");
  });
});

// ---------------------------------------------------------------------------
// digestPage parity with single-page composition
// ---------------------------------------------------------------------------

describe("digestPage", () => {
  it("matches single-page composition for a single-page input", () => {
    const events = sortDesc([
      makeEvent(NOW_MS - 1, "depeg.opened", { severity: "warning" }),
      makeEvent(NOW_MS - 2, "freeze.blocked", {
        coinId: null,
        payload: { stablecoin: "USDT", amountUsdAtEvent: 100 },
      }),
      makeEvent(NOW_MS - 25 * MS_PER_HOUR, "depeg.opened", { coinId: "dai" }),
    ]);

    const viaPage = mergeDigestedPages([digestPage(events, NOW_MS)]);
    const viaDirect = digestByDayForTest(events, NOW_MS);

    // Strip ordering-stable equality by JSON snapshot — both should be
    // identical including class ordering.
    expect(JSON.stringify(viaPage)).toBe(JSON.stringify(viaDirect));
  });

  it("carries raw events on each PageDigestedDay", () => {
    const events = sortDesc([
      makeEvent(NOW_MS - 1, "depeg.opened"),
      makeEvent(NOW_MS - 2, "depeg.opened"),
    ]);
    const [day] = digestPage(events, NOW_MS);
    expect(day!.events).toHaveLength(2);
    expect(day!.events.map((e) => e.id)).toEqual(events.map((e) => e.id));
  });
});

// ---------------------------------------------------------------------------
// mergeDigestedPages
// ---------------------------------------------------------------------------

function asPlain(days: DigestedDay[]): DigestedDay[] {
  // mergeDigestedPages output omits `events`; ensure direct shape comparison
  // ignores any incidental extra fields on the page-typed input.
  return days.map((d) => ({
    dayKey: d.dayKey,
    isToday: d.isToday,
    isYesterday: d.isYesterday,
    totalCount: d.totalCount,
    classes: d.classes,
  }));
}

describe("mergeDigestedPages", () => {
  it("handles disjoint days (no seam)", () => {
    const page1 = sortDesc([makeEvent(NOW_MS - 1, "depeg.opened")]);
    const page2 = sortDesc([makeEvent(NOW_MS - 25 * MS_PER_HOUR, "depeg.opened")]);

    const merged = mergeDigestedPages([
      digestPage(page1, NOW_MS),
      digestPage(page2, NOW_MS),
    ]);
    const direct = digestByDayForTest([...page1, ...page2], NOW_MS);

    expect(asPlain(merged)).toEqual(asPlain(direct));
    expect(merged.map((d) => d.dayKey)).toEqual([TODAY_KEY, YESTERDAY_KEY]);
  });

  it("merges a cross-page seam into a single day", () => {
    // Two pages that both contain events for the same UTC day.
    const page1 = sortDesc([
      makeEvent(NOW_MS - 1, "depeg.opened", { coinId: "usdc" }),
      makeEvent(NOW_MS - 2, "depeg.opened", { coinId: "dai" }),
    ]);
    const page2 = sortDesc([
      // Same UTC day as page1 — this is the seam.
      makeEvent(NOW_MS - 3, "depeg.opened", { coinId: "usdc" }),
      makeEvent(NOW_MS - 25 * MS_PER_HOUR, "depeg.opened", { coinId: "usdt" }),
    ]);

    const merged = mergeDigestedPages([
      digestPage(page1, NOW_MS),
      digestPage(page2, NOW_MS),
    ]);
    const direct = digestByDayForTest([...page1, ...page2], NOW_MS);

    expect(asPlain(merged)).toEqual(asPlain(direct));

    // Today should have 3 events across the merge.
    const today = merged.find((d) => d.dayKey === TODAY_KEY)!;
    expect(today.totalCount).toBe(3);

    // collapseByCoinClass must still group USDC across the seam into one
    // entry with count 2.
    const depegClass = today.classes.find((c) => c.classSlug === "depeg")!;
    const usdcEntry = depegClass.collapsed.find((c) => c.event.coinId === "usdc")!;
    expect(usdcEntry.count).toBe(2);
  });

  it("merges multiple seams across 3+ pages", () => {
    const page1 = sortDesc([
      makeEvent(NOW_MS - 1, "depeg.opened", { coinId: "usdc" }),
    ]);
    const page2 = sortDesc([
      // seam with page1 (same UTC day = today)
      makeEvent(NOW_MS - 2, "depeg.opened", { coinId: "usdc" }),
      // and starts yesterday too
      makeEvent(NOW_MS - 25 * MS_PER_HOUR, "depeg.opened", { coinId: "dai" }),
    ]);
    const page3 = sortDesc([
      // seam with page2 (same UTC day = yesterday)
      makeEvent(NOW_MS - 26 * MS_PER_HOUR, "depeg.opened", { coinId: "dai" }),
      makeEvent(NOW_MS - 50 * MS_PER_HOUR, "depeg.opened", { coinId: "usdt" }),
    ]);

    const merged = mergeDigestedPages([
      digestPage(page1, NOW_MS),
      digestPage(page2, NOW_MS),
      digestPage(page3, NOW_MS),
    ]);
    const direct = digestByDayForTest([...page1, ...page2, ...page3], NOW_MS);
    expect(asPlain(merged)).toEqual(asPlain(direct));

    expect(merged.map((d) => d.dayKey)).toEqual([
      TODAY_KEY,
      YESTERDAY_KEY,
      TWO_DAYS_AGO_KEY,
    ]);

    const today = merged.find((d) => d.dayKey === TODAY_KEY)!;
    expect(today.totalCount).toBe(2);
    const yesterday = merged.find((d) => d.dayKey === YESTERDAY_KEY)!;
    expect(yesterday.totalCount).toBe(2);

    // Yesterday's DAI events are split across page2/page3 — collapse should
    // count 2 for DAI.
    const yDepeg = yesterday.classes.find((c) => c.classSlug === "depeg")!;
    const daiEntry = yDepeg.collapsed.find((c) => c.event.coinId === "dai")!;
    expect(daiEntry.count).toBe(2);
  });

  it("handles empty pages", () => {
    const page1 = sortDesc([makeEvent(NOW_MS - 1, "depeg.opened")]);

    const merged = mergeDigestedPages([
      digestPage([], NOW_MS),
      digestPage(page1, NOW_MS),
      digestPage([], NOW_MS),
    ]);
    const direct = digestByDayForTest(page1, NOW_MS);

    expect(asPlain(merged)).toEqual(asPlain(direct));
  });

  it("returns empty array when all pages are empty", () => {
    expect(mergeDigestedPages([])).toEqual([]);
    expect(mergeDigestedPages([digestPage([], NOW_MS)])).toEqual([]);
    expect(
      mergeDigestedPages([digestPage([], NOW_MS), digestPage([], NOW_MS)]),
    ).toEqual([]);
  });

  it("preserves per-coin-class collapse across page seams", () => {
    // Three USDC depeg events split across two pages on the same day.
    const page1 = sortDesc([
      makeEvent(NOW_MS - 1, "depeg.opened", { coinId: "usdc" }),
      makeEvent(NOW_MS - 2, "depeg.opened", { coinId: "usdc" }),
    ]);
    const page2 = sortDesc([
      makeEvent(NOW_MS - 3, "depeg.opened", { coinId: "usdc" }),
      makeEvent(NOW_MS - 4, "depeg.opened", { coinId: "dai" }),
    ]);
    const merged = mergeDigestedPages([
      digestPage(page1, NOW_MS),
      digestPage(page2, NOW_MS),
    ]);
    const [today] = merged;
    expect(today!.dayKey).toBe(TODAY_KEY);
    const depeg = today!.classes.find((c) => c.classSlug === "depeg")!;

    // Two collapsed entries: USDC ×3 and DAI ×1.
    expect(depeg.collapsed).toHaveLength(2);
    const usdc = depeg.collapsed.find((c) => c.event.coinId === "usdc")!;
    const dai = depeg.collapsed.find((c) => c.event.coinId === "dai")!;
    expect(usdc.count).toBe(3);
    expect(dai.count).toBe(1);
    expect(depeg.rawCount).toBe(4);
    expect(depeg.useDigestWrapper).toBe(true);
  });

  it("recomputes class-level severity across seams", () => {
    // page1's `depeg` events are all info; page2 adds a critical event for
    // the same UTC day. Merged maxSeverity must be critical.
    const page1 = sortDesc([
      makeEvent(NOW_MS - 1, "depeg.opened", { severity: "info" }),
    ]);
    const page2 = sortDesc([
      makeEvent(NOW_MS - 2, "depeg.opened", { severity: "critical" }),
    ]);
    const merged = mergeDigestedPages([
      digestPage(page1, NOW_MS),
      digestPage(page2, NOW_MS),
    ]);
    const depeg = merged[0]!.classes.find((c) => c.classSlug === "depeg")!;
    expect(depeg.maxSeverity).toBe("critical");
  });
});
