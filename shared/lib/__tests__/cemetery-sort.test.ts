import { describe, expect, it } from "vitest";
import type { DeadStablecoin } from "../../types";
import { parseCemeteryDeathDate, sortCemeteryCoins } from "../cemetery";

function coin(id: string, deathDate: string, overrides: Partial<DeadStablecoin> = {}): DeadStablecoin {
  return {
    id,
    name: id,
    symbol: id.toUpperCase(),
    pegCurrency: "USD",
    causeOfDeath: "abandoned",
    deathDate,
    obituary: "Synthetic obituary.",
    sourceUrl: "https://example.com",
    sourceLabel: "Example",
    ...overrides,
  };
}

const ids = (coins: readonly DeadStablecoin[]) => coins.map((entry) => entry.id);

// No two rows share a date key, so the date alone decides this order.
const DATED = [
  coin("jun-17", "2026-06-17"),
  coin("jun-month", "2026-06", { peakMcap: 18_800_000_000 }),
  coin("may-31", "2026-05-31", { peakMcap: 40_000_000_000 }),
  coin("jun-30", "2026-06-30"),
  coin("jul-month", "2026-07"),
  coin("jun-01", "2026-06-01"),
  coin("dec-31-prev-year", "2025-12-31"),
  coin("jan-month", "2026-01"),
];
const DATED_NEWEST = ["jul-month", "jun-30", "jun-17", "jun-01", "jun-month", "may-31", "jan-month", "dec-31-prev-year"];

describe("sortCemeteryCoins", () => {
  it("orders by year, month, then day, placing a month-precision row at the start of its month", () => {
    // A month-only date never outranks a recorded day in the same month, even
    // with a far larger peak; a later month still outranks any earlier day.
    expect(ids(sortCemeteryCoins(DATED, "newest"))).toEqual(DATED_NEWEST);
    expect(ids(sortCemeteryCoins(DATED))).toEqual(DATED_NEWEST);
  });

  it("orders oldest-first as the exact reverse of the date order", () => {
    expect(ids(sortCemeteryCoins(DATED, "oldest"))).toEqual([...DATED_NEWEST].reverse());
  });

  it("places a year-precision row before January of its year", () => {
    const rows = [coin("y2025", "2025"), coin("jan-2025", "2025-01"), coin("dec-2024", "2024-12-31")];
    expect(ids(sortCemeteryCoins(rows, "newest"))).toEqual(["jan-2025", "y2025", "dec-2024"]);
    expect(ids(sortCemeteryCoins(rows, "oldest"))).toEqual(["dec-2024", "y2025", "jan-2025"]);
  });

  it("breaks same-date ties by peak descending, unknown peak last, then symbol and id, in both modes", () => {
    const tied = [
      coin("no-peak-b", "2024-03", { symbol: "USDB" }),
      coin("mid-peak", "2024-03", { peakMcap: 500_000_000, symbol: "ZED" }),
      coin("usdx-second", "2024-03", { symbol: "USDX" }),
      coin("major", "2024-03", { peakMcap: 2_000_000_000, symbol: "AAA" }),
      coin("lower-case", "2024-03", { symbol: "aUSD" }),
      coin("usdx-first", "2024-03", { symbol: "USDX" }),
      coin("small-peak", "2024-03", { peakMcap: 1_000_000, symbol: "AAA" }),
    ];
    // Symbols compare by code unit: every upper-case symbol precedes "aUSD"
    // whatever the runtime locale, so SSR and client orders cannot diverge.
    const expected = ["major", "mid-peak", "small-peak", "no-peak-b", "usdx-first", "usdx-second", "lower-case"];
    expect(ids(sortCemeteryCoins(tied, "newest"))).toEqual(expected);
    expect(ids(sortCemeteryCoins(tied, "oldest"))).toEqual(expected);
  });

  it("keeps rows with an unparseable deathDate after every dated row in both modes", () => {
    const rows = [coin("unknown", "not recorded"), coin("bad-month", "2026-13"), ...DATED];
    const newest = ids(sortCemeteryCoins(rows, "newest"));
    const oldest = ids(sortCemeteryCoins(rows, "oldest"));
    expect(newest.slice(0, DATED.length)).toEqual(DATED_NEWEST);
    expect(oldest.slice(0, DATED.length)).toEqual([...DATED_NEWEST].reverse());
    expect(newest.slice(DATED.length)).toEqual(["bad-month", "unknown"]);
    expect(oldest.slice(DATED.length)).toEqual(["bad-month", "unknown"]);
  });

  it("returns the same order for every input permutation without mutating the input", () => {
    const rows = [
      ...DATED,
      coin("tie-a", "2026-06-17", { symbol: "TIE" }),
      coin("tie-b", "2026-06-17", { symbol: "TIE" }),
      coin("unknown", ""),
    ];
    const inputOrder = ids(rows);
    const baseline = {
      newest: ids(sortCemeteryCoins(rows, "newest")),
      oldest: ids(sortCemeteryCoins(rows, "oldest")),
    };
    const permutations = [
      [...rows].reverse(),
      ...rows.map((_, offset) => [...rows.slice(offset), ...rows.slice(0, offset)]),
      rows.filter((_, index) => index % 2 === 0).concat(rows.filter((_, index) => index % 2 === 1)),
    ];
    for (const permutation of permutations) {
      expect(ids(sortCemeteryCoins(permutation, "newest"))).toEqual(baseline.newest);
      expect(ids(sortCemeteryCoins(permutation, "oldest"))).toEqual(baseline.oldest);
    }
    expect(ids(rows)).toEqual(inputOrder);
  });
});

describe("parseCemeteryDeathDate", () => {
  it("parses year, month and day precision", () => {
    expect(parseCemeteryDeathDate("2022")).toEqual({ year: 2022, month: null, day: null });
    expect(parseCemeteryDeathDate("2022-05")).toEqual({ year: 2022, month: 5, day: null });
    expect(parseCemeteryDeathDate("2022-05-09")).toEqual({ year: 2022, month: 5, day: 9 });
  });

  it("accepts the month and day range boundaries", () => {
    expect(parseCemeteryDeathDate("2022-01-01")).toEqual({ year: 2022, month: 1, day: 1 });
    expect(parseCemeteryDeathDate("2022-12-31")).toEqual({ year: 2022, month: 12, day: 31 });
  });

  it.each([
    "",
    "22",
    "20222",
    "2022-",
    "2022-5",
    "2022-005",
    "2022-05-",
    "2022-05-9",
    "2022-05-09-01",
    "2022-00",
    "2022-13",
    "2022-05-00",
    "2022-05-32",
    "2022/05/09",
    " 2022-05",
    "2022-0x",
    "+022-05",
    "２０２２-05",
  ])("rejects %j", (value) => {
    expect(parseCemeteryDeathDate(value)).toBeNull();
  });
});
