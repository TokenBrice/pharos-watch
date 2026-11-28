import { describe, expect, it, vi } from "vitest";
import {
  buildTrackedIdSet, exportStablecoinsCsv, getSupplyChangePercent, sortStablecoins,
  filterStablecoins, prioritizePinnedStablecoins, resolveDisplayedNativePrice,
  resolveEffectiveSortKey, type StablecoinTableSortKey,
} from "@/components/stablecoin-directory/stablecoin-table-logic";
import { buildStablecoinTableRowModel } from "@/components/stablecoin-directory/stablecoin-table-row-model";
import type { ColumnId } from "@/lib/column-visibility";
import { buildV9SafetyTableMap, type V9SafetyTableRow } from "@/lib/safety-score-v9-consumers";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";
import { makePegSummaryCoin } from "@/test-utils/peg-summary-fixtures";
import { makeDexLiquidityData } from "@/test/fixtures/dex-liquidity";
import type { PegSummaryCoin } from "@shared/types/peg";
import type { StablecoinData } from "@shared/types/supply";
import type { DexLiquidityMap } from "@shared/types/dex-liquidity";
import type { SafetyScoreV9CurrentCard } from "@shared/types/safety-score-v9-public";
import { makeChainGapGuard, makeStablecoin } from "@shared/test-utils/stablecoin";
import { FX_REOPEN_QUOTE_AT, makeFxCurrentPeg } from "@shared/test-utils/boundary-contract-vectors.test-support";
import { getQuoteMatchedNavPriceReference as navRef } from "@/lib/nav-price-reference";
import { formatComparisonPrice } from "@/lib/current-peg";
import type { CsvColumn } from "@/lib/exports/csv";
import { buildCsvBody } from "@shared/lib/csv";
import type { ExportPreamble } from "@/lib/exports/preamble";
import { formatPreambleCsv } from "@/lib/exports/preamble";
import { createTableComparator } from "@/lib/table-comparator";

const { downloadCsvMock } = vi.hoisted(() => ({ downloadCsvMock: vi.fn() }));
vi.mock("@/lib/exports/csv", () => ({ downloadCsvWithPreamble: downloadCsvMock }));

const H_MCAP = "Market Cap (USD)", H_24H = "24h Market Cap Change (%)", H_7D = "7d Market Cap Change (%)";
const usd = (n: number) => ({ peggedUSD: n });
const asc = (key: StablecoinTableSortKey) => ({ key, direction: "asc" as const });
const desc = (key: StablecoinTableSortKey) => ({ key, direction: "desc" as const });
const iso = (hms: string) => `2026-09-01T${hms}.000Z`;
const liq = (liquidityScore: number) => makeDexLiquidityData({ liquidityScore });
const card = (id: string, score: number, ov: Parameters<typeof makeV9Card>[0] = {}) => makeV9Card({ id, score, ...ov });

function coin(id: string, name = id, ov: Partial<StablecoinData> = {}): StablecoinData {
  const c = makeStablecoin({
    id, name, symbol: id.toUpperCase(), priceSource: "coingecko", priceConfidence: "high",
    circulatingPrevDay: usd(1e6), circulatingPrevWeek: usd(1e6), supplySource: "defillama", chains: ["ethereum"], ...ov,
  });
  const [day, week] = [c.circulatingPrevDay?.peggedUSD, c.circulatingPrevWeek?.peggedUSD];
  return {
    ...c,
    supplyChangeBaselines: {
      ...(day != null ? { day: { circulatingUsd: day, circulatingNative: null, observedAt: 1_700_000_000 - 86_400 } } : {}),
      ...(week != null ? { week: { circulatingUsd: week, circulatingNative: null, observedAt: 1_700_000_000 - 7 * 86_400 } } : {}),
    },
  };
}

type Sources = { pegScores?: Map<string, PegSummaryCoin>; dexLiquidity?: DexLiquidityMap; reportCards?: Record<string, V9SafetyTableRow> };
const sortedIds = (filtered: StablecoinData[], sort: { key: StablecoinTableSortKey; direction: "asc" | "desc" }, sources: Sources = {}) =>
  sortStablecoins({ filtered, sort, effectiveSortKey: sort.key, ...sources }).map((c) => c.id);
const ranks = (rows: StablecoinData[]) => new Map(rows.map((r, i) => [r.id, i + 1]));
const runCsv = (...args: Parameters<typeof exportStablecoinsCsv>) => {
  downloadCsvMock.mockReset();
  exportStablecoinsCsv(...args);
  return downloadCsvMock.mock.calls[0]! as [StablecoinData[], CsvColumn<StablecoinData>[], string, ExportPreamble];
};
const csvOf = (rows: StablecoinData[], ...rest: [Map<string, PegSummaryCoin>?, DexLiquidityMap?, Record<string, V9SafetyTableRow>?, Parameters<typeof exportStablecoinsCsv>[5]?, string?]) =>
  runCsv(rows, ranks(rows), ...rest);
const col = (cols: CsvColumn<StablecoinData>[], header: string) => cols.find((c) => c.header === header)!;
const pegMap = (entries: Array<[string, Partial<PegSummaryCoin>]>) => new Map(entries.map(([id, ov]) => [id, makePegSummaryCoin({ id, ...ov })]));
const safetyRows = (cards: SafetyScoreV9CurrentCard[]): Record<string, V9SafetyTableRow> => {
  const res = makeReportCardsV9Response({ cards }), proj = buildV9SafetyTableMap(res, res.safetyScoreIdentity);
  return proj.status === "available" ? proj.value : {};
};

describe("nominal price consumers", () => {
  it("displays the observed USD NAV when the GBP reference is a three-contributor peer median", () => {
    const quote = coin("gbpsafo-spiko", "GBPSAFO", { price: 1.31, pegType: "peggedGBP", priceObservedAt: FX_REOPEN_QUOTE_AT });
    const peer = { ...makePegSummaryCoin({ pegCurrency: "GBP", pegType: "peggedGBP", priceObservedAt: FX_REOPEN_QUOTE_AT }), ...makeFxCurrentPeg("admitted", 0) };
    const median = { ...peer, pegReference: { ...peer.pegReference, source: "median" as const, contributorCount: 3 }, referenceAdmission: { ...peer.referenceAdmission, kind: "median" as const, source: "peer-median" as const } };
    const ref = navRef("GBP", quote.priceObservedAt, [median]);
    const { referenceAdmission: _v, admittedDeviationBps: _b, ...legacy } = median;
    expect([ref, navRef("GBP", undefined, [legacy]), navRef("GBP", undefined, [legacy, median]), formatComparisonPrice(quote, "GBP", ref), navRef("GBP", quote.priceObservedAt, [peer]), navRef("GBP", quote.priceObservedAt, [{ ...peer, pegType: "peggedEUR" }])])
      .toEqual([null, 1.1, null, "$1.3100", 1.1, null]);
  });

  it("sorts nominal prices as missing and exports no observed quote", () => {
    const nominal = coin("nominal", "Nominal", { price: 1, priceSource: "protocol-par", priceObservedAtMode: "nominal_reference", priceConfidence: "high" });
    const market = coin("market", "Market", { price: 1.1 });
    const sorted = sortStablecoins({ filtered: [nominal, market], sort: asc("price"), effectiveSortKey: "price" });
    expect(sorted.map((c) => c.id)).toEqual(["market", "nominal"]);
    const pCol = col(csvOf(sorted)[1], "Price");
    expect([pCol.accessor(nominal, 1), pCol.accessor(market, 0)]).toEqual([null, 1.1]);
  });
});

describe("stablecoin export provenance", () => {
  const t = Date.parse(iso("12:00:00")) / 1000;

  it("dates the export by the oldest known upstream generation and preserves unknown clocks and cells", () => {
    const rows = [coin("zero", "Zero", { circulating: usd(0) }), coin("unknown", "Unknown", { circulating: {} })];
    const [exported, cols, , pre] = csvOf(rows, new Map(), {}, {}, { stablecoins: t, pegSummary: t - 60, reportCards: null });
    expect([exported === rows, pre.asOfISO]).toEqual([true, iso("11:59:00")]);
    const hdr = formatPreambleCsv(pre);
    for (const s of [`stablecoins=${iso("12:00:00")}`, `pegSummary=${iso("11:59:00")}`, "dexLiquidity=unknown", "reportCards=unknown"]) expect(hdr).toContain(s);
    const supply = col(cols, H_MCAP);
    expect([supply.accessor(rows[0], 0), supply.accessor(rows[1], 1), csvOf(rows)[3].asOfISO]).toEqual([0, null, "unknown"]);
  });

  it("names every participating source and keeps never-read sources visible as unknown generations", () => {
    const rows = [coin("usdc", "USDC")];
    const [, , , full] = csvOf(rows, new Map(), {}, {}, { stablecoins: t, pegSummary: t - 60, dexLiquidity: t - 30, reportCards: t - 3600 });
    expect([full.asOfISO, full.sourceGenerations]).toEqual([iso("11:00:00"), { stablecoins: iso("12:00:00"), pegSummary: iso("11:59:00"), dexLiquidity: iso("11:59:30"), reportCards: iso("11:00:00") }]);

    const [, , , partial] = csvOf(rows, new Map(), undefined, undefined, { stablecoins: t, pegSummary: t - 60 });
    expect([partial.asOfISO, partial.sourceGenerations]).toEqual([iso("11:59:00"), { stablecoins: iso("12:00:00"), pegSummary: iso("11:59:00"), dexLiquidity: null, reportCards: null }]);
    expect(formatPreambleCsv(partial)).toContain("reportCards=unknown");
  });

  it("appends the loaded report-card methodology version to the CSV label", () => {
    const rows = [coin("usdc", "USDC")];
    expect([csvOf(rows, new Map(), {}, {}, {}, "10.01")[3].methodologyLabel, csvOf(rows, new Map(), {}, undefined, {}, "10.01")[3].methodologyLabel])
      .toEqual(["published source values · safety-score v10.01", "published source values"]);
  });
});

describe("carried supply consumers", () => {
  it("withholds a restored row's change from the cell, sort and CSV instead of dating a stale observation as 24h", () => {
    const restored = coin("restored", "Restored", { circulating: usd(100e6), circulatingPrevDay: usd(95e6), circulatingPrevWeek: usd(90e6), supplyRestored: true, supplyObservedAt: Math.floor(Date.now() / 1000) - 3 * 86_400 });
    const dated = { ...restored, supplyChangeBaselines: { day: { circulatingUsd: 110e6, circulatingNative: null, observedAt: 1_792_700_000 } } };
    expect(getSupplyChangePercent(dated, "day")).toBeNull();
    expect(getSupplyChangePercent({ ...dated, supplyRestored: false }, "day")).toBeCloseTo(-100 / 11);
    expect(getSupplyChangePercent({ ...dated, supplyRestored: false }, 95e6)).toBeNull();
    expect(sortedIds([restored, coin("fresh", "Fresh")], desc("change24h"))).toEqual(["fresh", "restored"]);
    expect(col(csvOf([restored])[1], H_24H).accessor(restored, 0)).toBeNull();
  });
});

describe("supply availability consumers", () => {
  const unavailable = coin("unavailable", "Unavailable", { circulating: {} }), observed = coin("observed", "Observed", { circulating: usd(50) }), zero = coin("zero", "Zero", { circulating: usd(0) });
  const missingDay = coin("missing-day", "Missing Day", { circulating: usd(50), circulatingPrevDay: {}, circulatingPrevWeek: usd(40) });

  it.each(["mcap", "change24h", "change7d"] as const)("sorts unavailable %s last in either direction and retains observed zero", (key) => {
    const rows = [unavailable, observed, zero];
    expect([sortedIds(rows, asc(key)), sortedIds(rows, desc(key))]).toEqual([["zero", "observed", "unavailable"], ["observed", "zero", "unavailable"]]);
  });

  it("sorts missing day history last without discarding its weekly observation", () => {
    expect([sortedIds([missingDay, observed], asc("change24h")), sortedIds([missingDay, observed], desc("change7d"))]).toEqual([["observed", "missing-day"], ["missing-day", "observed"]]);
  });

  it("exports absent supply and deltas as empty cells but explicit zero as zero and -100", () => {
    const [rows, cols] = csvOf([unavailable, missingDay, zero]);
    expect(buildCsvBody(rows, cols.filter((c) => [H_MCAP, H_24H, H_7D].includes(c.header))))
      .toEqual([`${H_MCAP},${H_24H},${H_7D}`, ",,", "50,,25", "0,-100,-100"]);
  });
});

describe("filterStablecoins, buildTrackedIdSet, and prioritizePinnedStablecoins", () => {
  it.each([
    ["untracked coins", ["usdc"], "", ["usdc"]],
    ["name match", ["usdc", "usdt"], "Tether", ["usdt"]],
    ["case-insensitive symbol match", ["usdc", "dai"], "DAI", ["dai"]],
    ["empty query", ["usdc", "dai"], "", ["usdc", "dai"]],
  ] as const)("filters by %s", (_l, tracked, q, exp) => {
    expect(filterStablecoins([coin("usdc", "USD Coin"), coin("usdt", "Tether"), coin("dai", "Dai")], new Set(tracked), q).map((c) => c.id)).toEqual([...exp]);
  });

  it("intersects metadata filters with an explicit listing universe", () => {
    const eligible = new Set(["susds-sky", "usdt-tether"]);
    expect([buildTrackedIdSet([], undefined, eligible), buildTrackedIdSet(["variant-tracked"], undefined, eligible)]).toEqual([eligible, new Set(["susds-sky"])]);
  });

  it.each([
    ["moves pinned rows to the top in pinned order", ["usdt-tether", "usdc-circle", "dai-maker"], ["dai-maker", "usdc-circle"], ["dai-maker", "usdc-circle", "usdt-tether"]],
    ["ignores pinned ids not in current filtered rows", ["usdt-tether", "usdc-circle"], ["missing", "usdc-circle"], ["usdc-circle", "usdt-tether"]],
  ] as const)("%s", (_l, ids, pinned, exp) => {
    expect(prioritizePinnedStablecoins(ids.map((id) => coin(id)), [...pinned]).map((c) => c.id)).toEqual([...exp]);
  });

  it.each([
    ["asc", false, false, ["1,Alpha", "2,Beta", "3,Gamma"]], ["asc", false, true, ["2,Beta", "1,Alpha", "3,Gamma"]],
    ["desc", false, false, ["1,Gamma", "2,Beta", "3,Alpha"]], ["desc", false, true, ["2,Beta", "1,Gamma", "3,Alpha"]],
    ["asc", true, false, ["1,Alpha", "2,Beta"]], ["asc", true, true, ["2,Beta", "1,Alpha"]],
    ["desc", true, false, ["1,Beta", "2,Alpha"]], ["desc", true, true, ["1,Beta", "2,Alpha"]],
  ] as const)("exports pre-pin ranks in full displayed order (%s, filtered=%s, pinned=%s)", (direction, filtered, pinned, exp) => {
    const rows = [coin("alpha", "Alpha", { circulating: usd(10) }), coin("beta", "Beta", { circulating: usd(20) }), coin("gamma", "Gamma", { circulating: usd(30) })];
    const sorted = sortStablecoins({ filtered: filterStablecoins(rows, new Set(filtered ? ["alpha", "beta"] : ["alpha", "beta", "gamma"]), ""), sort: { key: "mcap", direction }, effectiveSortKey: "mcap" });
    const displayed = prioritizePinnedStablecoins(sorted, pinned ? ["beta"] : []);
    const [exported, cols] = runCsv(displayed, ranks(sorted));
    expect(exported).toBe(displayed);
    expect(buildCsvBody(exported, cols.filter((c) => ["Rank", "Name"].includes(c.header)))).toEqual(["Rank,Name", ...exp]);
  });
});

describe("sortStablecoins", () => {
  const heldCards = () => safetyRows([card("held", 62, { grade: "B", gradeHold: { rawGrade: "C+", heldFromGenerationId: "generation-1" } }), card("raw", 69, { grade: "B-" })]);

  it.each<[string, StablecoinData[], { key: StablecoinTableSortKey; direction: "asc" | "desc" }, string[], Sources?]>([
    ["names ascending", [coin("b", "Zebra"), coin("a", "Apple")], asc("name"), ["a", "b"]],
    ["names descending", [coin("a", "Apple"), coin("b", "Zebra")], desc("name"), ["b", "a"]],
    ["price ascending", [coin("a", "A", { price: 1.05 }), coin("b", "B", { price: 0.98 })], asc("price"), ["b", "a"]],
    ["unknown price last descending", [coin("a", "A", { price: null }), coin("b", "B", { price: 1 })], desc("price"), ["b", "a"]],
    ["unknown price last ascending", [coin("a", "A", { price: null }), coin("b", "B", { price: 1 })], asc("price"), ["b", "a"]],
    ["Worker current peg deviation", [coin("higher", "Higher", { price: 1.004949 }), coin("lower", "Lower", { price: 1.004941 })], asc("peg"), ["lower", "higher"], { pegScores: pegMap([["higher", { currentDeviationBps: 50 }], ["lower", { currentDeviationBps: 49 }]]) }],
    ["peg score descending", [coin("a", "A"), coin("b", "B")], desc("stability"), ["a", "b"], { pegScores: pegMap([["a", { symbol: "A", pegScore: 95 }], ["b", { symbol: "B", pegScore: 70 }]]) }],
    ["missing peg score last", [coin("noScore"), coin("hasScore")], desc("stability"), ["hasScore", "noScore"], { pegScores: pegMap([["hasScore", { symbol: "H", pegScore: 80 }]]) }],
    ["liquidity score descending", [coin("low"), coin("high")], desc("liquidity"), ["high", "low"], { dexLiquidity: { low: liq(20), high: liq(90) } }],
    ["null liquidity last", [coin("noLiq"), coin("hasLiq")], desc("liquidity"), ["hasLiq", "noLiq"], { dexLiquidity: { hasLiq: liq(50) } }],
    ["V9 score descending", [coin("b"), coin("a")], desc("grade"), ["a", "b"], { reportCards: safetyRows([card("a", 85), card("b", 60)]) }],
    ["null V9 score last", [coin("noGrade"), coin("hasGrade")], desc("grade"), ["hasGrade", "noGrade"], { reportCards: safetyRows([card("hasGrade", 70)]) }],
    ["published letter grade descending over held raw score", [coin("held"), coin("raw")], desc("grade"), ["held", "raw"], { reportCards: heldCards() }],
    ["published letter grade ascending over held raw score", [coin("held"), coin("raw")], asc("grade"), ["raw", "held"], { reportCards: heldCards() }],
    ["24h supply change descending", [coin("grow", "Growing", { circulating: usd(1.1e6) }), coin("shrink", "Shrinking", { circulating: usd(9e5) })], desc("change24h"), ["grow", "shrink"]],
    ["7d supply change ascending", [coin("grow", "Growing", { circulating: usd(1.2e6) }), coin("stable", "Stable", { circulating: usd(1e6) })], asc("change7d"), ["stable", "grow"]],
  ])("sorts %s", (_n, rows, sort, exp, src) => { expect(sortedIds(rows, sort, src)).toEqual(exp); });

  it("sorts the Price column in the peg quantity the cell prints", () => {
    const [u, brl, noRef] = [coin("usdc-circle", "USD Coin", { price: 0.99 }), coin("brl1-brl1", "BRL1", { price: 0.18 }), coin("brla-brla-digital", "BRLA", { price: 0.18 })];
    const ref = (valueUsd: number) => ({ valueUsd, source: "median" as const, contributorCount: 5, asOf: 1_700_000_000 });
    const pegScores = pegMap([["usdc-circle", { pegCurrency: "USD", pegReference: ref(1) }], ["brl1-brl1", { pegCurrency: "BRL", pegReference: ref(0.18) }]]);
    expect([
      sortedIds([u, brl, noRef], desc("price"), { pegScores }),
      resolveDisplayedNativePrice(brl, pegScores.get("brl1-brl1"), pegScores),
      resolveDisplayedNativePrice(u, pegScores.get("usdc-circle"), pegScores),
      resolveDisplayedNativePrice(noRef, undefined, pegScores),
    ]).toEqual([["brl1-brl1", "usdc-circle", "brla-brla-digital"], { value: 1, currency: "BRL", reference: 0.18 }, { value: 0.99, currency: "USD", reference: 1 }, null]);
  });

  it("sorts the visible USD fallback during a legacy FX session hold", () => {
    const at = Date.parse("2026-11-14T14:00:00Z") / 1000;
    const eurc = coin("eurc-circle", "EURC", { price: 1.122, pegType: "peggedEUR", priceObservedAt: at, currentPeg: { currentDeviationBps: 200, currentPriceUnavailable: false, pegReferenceUnavailable: false, pegReference: { valueUsd: 1.1, source: "fx", contributorCount: 0, asOf: at - 86_400 }, dexPriceCheck: null, primaryTrust: "unusable" } });
    const [usdc, missing] = [coin("usdc-circle", "USDC", { price: 1 }), coin("missing", "Missing", { price: null })];
    expect([buildStablecoinTableRowModel({ coin: eurc, density: "compact", variant: "default" }).priceCell, resolveDisplayedNativePrice(eurc, undefined), sortedIds([missing, usdc, eurc], desc("price"))])
      .toEqual(["$1.1220", { value: 1.122, currency: "USD", reference: null }, [eurc.id, usdc.id, missing.id]]);
  });

  it.each(["matched", "held", "stale", "unmatched", "median"] as const)("sorts a non-USD NAV in the displayed unit (%s)", (scenario) => {
    const quoteAt = FX_REOPEN_QUOTE_AT;
    const nav = coin("gbpsafo-spiko", "GBP NAV", { price: 1.21, priceObservedAt: scenario === "unmatched" ? quoteAt - 60 : quoteAt });
    const cur = scenario === "held" || scenario === "stale" ? makeFxCurrentPeg("stale-reference", null) : makeFxCurrentPeg("admitted", 0);
    const peer: PegSummaryCoin = { ...makePegSummaryCoin({ id: "gbpa-agant", pegCurrency: "GBP", pegType: "peggedGBP", priceObservedAt: quoteAt, price: 1.1 }), ...cur, ...(scenario === "held" ? { referenceAdmission: { ...cur.referenceAdmission, status: "held-closed-session", reason: "reference-market-closed" } } : {}) };
    if (scenario === "median" && peer.pegReference) peer.pegReference = { ...peer.pegReference, source: "median", contributorCount: 3 };
    const key = resolveDisplayedNativePrice(nav, undefined, new Map([[peer.id, peer]]));
    if (scenario === "matched") expect(key).toMatchObject({ value: expect.closeTo(1.1), currency: "GBP" });
    else expect(key).toEqual({ value: 1.21, currency: "USD", reference: null });
  });

  it("treats missing Worker deviations as absent peg signals", () => {
    const res = sortedIds([coin("missing", "M", { price: null }), coin("invalid", "I", { price: Number.NaN }), coin("exact", "E", { price: 1 })], asc("peg"), { pegScores: pegMap([["missing", { currentDeviationBps: null }], ["invalid", { currentDeviationBps: null }], ["exact", { currentDeviationBps: 0 }]]) });
    expect([res[0], new Set(res.slice(1))]).toEqual(["exact", new Set(["missing", "invalid"])]);
  });
});

describe("resolveEffectiveSortKey & blacklistable projection", () => {
  it("keeps a grade order on phone, where the row risk summary prints the grade", () => {
    const phone = new Set<ColumnId>(["rank", "name", "price", "mcap", "change24h"]);
    expect([resolveEffectiveSortKey("grade", phone), resolveEffectiveSortKey("grade", phone, true), resolveEffectiveSortKey("stability", phone, true)]).toEqual(["mcap", "grade", "mcap"]);
  });

  it("sorts and exports reviewed FreezeWatch status before stale V9 freeze exposure", () => {
    const fp = (id: string) => makeV9Card({ id, accessPosture: { ...makeV9Card().accessPosture, freezeExposure: "possible" } });
    const lusd = coin("lusd-liquity", "Liquity USD"), rt = coin("runtime-possible", "Runtime Possible");
    expect(sortedIds([rt, lusd], asc("blacklistable"), { reportCards: safetyRows([fp("lusd-liquity"), fp("runtime-possible")]) })).toEqual(["lusd-liquity", "runtime-possible"]);
    expect(col(csvOf([lusd], undefined, undefined, safetyRows([fp("lusd-liquity")]))[1], "Blacklistable").accessor(lusd, 0)).toBe("No");
  });
});

describe("supply-change semantics", () => {
  it.each(["change24h", "change7d"] as const)("sorts partial %s last in both directions and exports no change", (key) => {
    const partial = coin("partial", "Partial", { circulating: usd(50), supplyChainGuard: makeChainGapGuard(true) }), unchanged = coin("unchanged", "Unchanged", { circulating: usd(1e6) }), zero = coin("zero", "Zero", { circulating: usd(0) });
    expect([sortedIds([partial, unchanged, zero], asc(key)), sortedIds([partial, unchanged, zero], desc(key))])
      .toEqual([["zero", "unchanged", "partial"], ["unchanged", "zero", "partial"]]);
    const [, cols] = runCsv([partial, unchanged, zero], new Map());
    for (const h of [H_24H, H_7D]) {
      const c = col(cols, h);
      expect([c.accessor(partial, 0), c.accessor(unchanged, 1), c.accessor(zero, 2)]).toEqual([null, 0, -100]);
    }
  });

  it("sorts a missing previous supply last and exports it as null", () => {
    const missing = coin("missing", "Missing", { circulating: usd(1e6), circulatingPrevDay: undefined });
    const rows = [missing, coin("shrink", "Shrinking", { circulating: usd(9e5) }), coin("grow", "Growing", { circulating: usd(1.1e6) })];
    expect(sortedIds(rows, desc("change24h"))).toEqual(["grow", "shrink", "missing"]);
    expect(col(csvOf([missing])[1], H_24H).accessor(missing, 0)).toBeNull();
  });
});

interface CmpRow { name: string; value: number; score: number | null; }
const r = (name: string, value: number, score: number | null = null): CmpRow => ({ name, value, score });
const accessors = { name: (x: CmpRow) => x.name, value: (x: CmpRow) => x.value, score: (x: CmpRow) => x.score };

describe("createTableComparator", () => {
  it.each<[string, keyof CmpRow, "asc" | "desc", CmpRow[], (number | string | null)[], "first"?]>([
    ["numbers ascending", "value", "asc", [r("B", 20), r("A", 10)], [10, 20]],
    ["strings ascending", "name", "asc", [r("Banana", 1), r("Apple", 2)], ["Apple", "Banana"]],
    ["null after non-null ascending by default", "score", "asc", [r("A", 1), r("B", 2, 50)], [50, null]],
    ["null before non-null ascending when configured", "score", "asc", [r("B", 2, 50), r("A", 1)], [null, 50], "first"],
    ["mixed null and non-null entries descending", "score", "desc", [r("A", 1), r("B", 2, 80), r("C", 3), r("D", 4, 30), r("E", 5, 60)], [80, 60, 30, null, null]],
  ])("sorts %s", (_n, key, direction, rows, exp, nullPosition) => {
    const cmp = createTableComparator<keyof CmpRow, CmpRow>(accessors, nullPosition ? { nullPosition } : undefined);
    rows.sort((a, b) => cmp(a, b, { key, direction }));
    expect(rows.map((x) => x[key])).toEqual(exp);
  });

  it("returns 0 for an unrecognized key", () => {
    expect(createTableComparator<keyof CmpRow, CmpRow>(accessors)(r("A", 1), r("B", 2), { key: "unknown" as "name", direction: "asc" })).toBe(0);
  });
});
