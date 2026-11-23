import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRACKED_STABLECOINS as COINS } from "@shared/lib/stablecoins/registry";
import { StablecoinDetailResponseSchema, SupplyHistoryResponseSchema, type SupplyHistoryPoint } from "@shared/types/supply";
import { projectStablecoinLiveSummary } from "@shared/lib/stablecoin-live-summary";
import { readDetailSnapshot } from "../../../src/lib/stablecoin-detail-snapshot-reader";
import type { StablecoinLiveSummary } from "@shared/types/stablecoin-live-summary";
import {
  DETAIL_SNAPSHOT_INPUT_BATCH_SIZE as BATCH_SIZE,
  DETAIL_SNAPSHOT_INPUT_LEGACY_BATCH_SIZE as LEGACY_BATCH_SIZE,
  DetailSnapshotInputsResponseSchema,
  type DetailSnapshotInputEntry,
} from "@shared/types/detail-snapshot-inputs";
import {
  buildStablecoinDetailSnapshots,
  type SnapshotInputs,
  checkSnapshots,
  DETAIL_SNAPSHOT_STALE_REFRESH_LIMIT,
  DETAIL_SNAPSHOT_TARGET_BYTES,
  DETAIL_SNAPSHOT_UI_STALE_AFTER_MS as UI_STALE_MS,
  fetchOptionalDetailSnapshotLane,
  generateSnapshots,
  reportSnapshotProducerAges as reportAges,
  selectStaleDetailSnapshotRefreshIds as selectRefreshIds,
  serializedSnapshotBytes,
  validateStablecoinDetailSnapshot as validateSnapshot,
  writeSnapshots,
} from "../build-stablecoin-detail-snapshots";

// Generation tests stay independent of the committed scores-latest mirror; the
// release-assessment lane is exercised through the injected reader below.
vi.mock("../../../src/lib/safety-grade-snapshot", () => ({ getScoresLatestSnapshotRow: () => null }));

const USDT = "usdt-tether";
const USDC = "usdc-circle";

const SCORES_ROW = {
  grade: "A-" as const, score: 81, dewsScore: 17, dewsBand: "WATCH" as const, liquidityScore: 67,
  asOfMs: 1_700_000_050_000,
};

function liveSummary(overrides: Partial<StablecoinLiveSummary> = {}): StablecoinLiveSummary {
  return {
    price: 1, priceSource: null, priceConfidence: null, priceUpdatedAt: null, priceObservedAt: null, supplyObservedAt: 1_700_000_000,
    circulating: { peggedUSD: 100 }, circulatingPrevDay: { peggedUSD: 99 }, circulatingPrevWeek: { peggedUSD: 98 }, circulatingPrevMonth: { peggedUSD: 97 },
    nativeSupply: { current: 100, prevWeek: 98, prevMonth: 97 }, ...overrides,
  };
}

const DETAIL_URL = "https://api.pharos.watch/api/stablecoin/usdt-tether";
const HISTORY_URL = "https://api.pharos.watch/api/supply-history";
const API_URL_ENVS = ["DIGEST_API_URL", "PUBLIC_DATASETS_API_URL", "SMOKE_API_BASE", "API_BASE_URL"];
const EMPTY_SOURCES = { detailCacheUpdatedAt: null, publicationUpdatedAt: null, supplySnapshotUpdatedAt: null, supplySnapshotDate: null };
const LIVE_IDS = COINS.filter((coin) => coin.status == null || coin.status === "active" || coin.status === "frozen").map((coin) => coin.id);

const credentials = (apiKey = "fixture-key", siteSecret?: string) => {
  vi.stubEnv("PHAROS_API_KEY", apiKey);
  if (siteSecret !== undefined) vi.stubEnv("SITE_API_SHARED_SECRET", siteSecret);
};
const clearApiUrls = () => { for (const name of API_URL_ENVS) vi.stubEnv(name, ""); };
const buildSnapshots = (inputs: Partial<SnapshotInputs> = {}) => buildStablecoinDetailSnapshots({
  generatedAt: 1_700_000_000_000, liveSummariesById: new Map(), supplyHistoryById: new Map(), updatedAtById: new Map(), ...inputs,
});
const buildSnapshot = ({ summary, history, updatedAt, ...inputs }: Partial<SnapshotInputs> & {
  summary: StablecoinLiveSummary; history: SupplyHistoryPoint[]; updatedAt?: { liveSummary?: number; supplyHistory?: number };
}) => buildSnapshots({
  liveSummariesById: new Map([[USDT, summary]]), supplyHistoryById: new Map([[USDT, history]]),
  updatedAtById: updatedAt === undefined ? new Map() : new Map([[USDT, updatedAt]]), ...inputs,
}).find((s) => s.stablecoinId === USDT)!;
const fetchDetail = (label = "detail") => fetchOptionalDetailSnapshotLane(label, DETAIL_URL, StablecoinDetailResponseSchema);
const fetchHistory = (label = "history") => fetchOptionalDetailSnapshotLane(label, HISTORY_URL, SupplyHistoryResponseSchema);
const snapshotFor = (snapshots: ReturnType<typeof buildSnapshots>, id = USDT) => snapshots.find((s) => s.stablecoinId === id)!;
const oversizedHistory = () => Array.from({ length: 500 }, (_, i) => ({ date: 1_600_000_000 + i * 86_400, circulatingUsd: 100_000_000 + i, price: 1 }));
const coinRequest = (raw: string) => {
  const url = new URL(raw), history = url.pathname.endsWith("/supply-history");
  return { url, history, id: history ? url.searchParams.get("stablecoin")! : url.pathname.split("/").at(-1)! };
};
const bulkResponse = (url: URL, entry: (id: string) => DetailSnapshotInputEntry) => Response.json({ version: 1, entries: url.searchParams.get("ids")!.split(",").map(entry) });
const entryFor = (entries: { id: string }[], id: string) => entries.find((e) => e.id === id);
const laneClocks = (clock: number) => ({ liveSummary: clock, supplyHistory: clock });
const bulkEntry = (id: string, updatedAt: number, overrides: Partial<Extract<DetailSnapshotInputEntry, { status: "available" }>> = {}): DetailSnapshotInputEntry => ({
  id, status: "available", liveSummary: liveSummary(), supplyHistory: [], updatedAt: laneClocks(updatedAt),
  freshness: { liveSummary: { status: "stale", maxAgeSec: 300 }, supplyHistory: { status: "fresh", maxAgeSec: 86_400 } },
  sources: { detailCacheUpdatedAt: updatedAt / 1000, publicationUpdatedAt: updatedAt / 1000, supplySnapshotUpdatedAt: updatedAt / 1000, supplySnapshotDate: updatedAt / 1000 },
  ...overrides,
});
const silence = (method: "warn" | "log" = "warn") => vi.spyOn(console, method).mockImplementation(() => undefined);

describe("stablecoin detail snapshot generator", () => {
  it("bootstraps checkable empty envelopes without credentials or network and reconciles catalog membership", async () => {
    const fetch = vi.fn(() => { throw new Error("Network forbidden during bootstrap"); });
    const loadEnv = vi.spyOn(process, "loadEnvFile").mockImplementation(() => { throw new Error("No credential loading"); });
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("PHAROS_DETAIL_SNAPSHOT_BOOTSTRAP", "1");
    const outputDir = mkdtempSync(join(tmpdir(), "detail-bootstrap-"));
    try {
      const snapshots = await generateSnapshots();
      expect(snapshots).toHaveLength(COINS.length);
      expect(snapshots.every((s) => s.generatedAt === 0 && Object.keys(s.lanes).length === 0)).toBe(true);
      writeSnapshots(snapshots, outputDir);
      expect(checkSnapshots(outputDir)).toEqual(snapshots);
      const firstPath = join(outputDir, `${COINS[0].id}.json`), firstBytes = readFileSync(firstPath);
      expect(readDetailSnapshot(firstPath)).toEqual({ status: "available", snapshot: snapshots[0] });
      rmSync(firstPath);
      expect(() => checkSnapshots(outputDir)).toThrow(/Missing stablecoin detail snapshot/);
      const warn = silence();
      expect(readDetailSnapshot(firstPath)).toEqual({ status: "missing", snapshot: null });
      expect(warn).toHaveBeenLastCalledWith(`[stablecoin-detail-snapshot] missing: ${firstPath}; rendering without snapshot`);
      writeFileSync(firstPath, "{");
      expect(readDetailSnapshot(firstPath)).toEqual({ status: "malformed", snapshot: null });
      expect(warn).toHaveBeenLastCalledWith(`[stablecoin-detail-snapshot] malformed: ${firstPath}; rendering without snapshot`);
      expect(readDetailSnapshot(outputDir)).toEqual({ status: "unreadable", snapshot: null });
      expect(warn).toHaveBeenLastCalledWith(`[stablecoin-detail-snapshot] unreadable: ${outputDir}; rendering without snapshot`);
      writeFileSync(firstPath, firstBytes);
      writeFileSync(join(outputDir, "removed-coin.json"), "{}");
      expect(() => checkSnapshots(outputDir)).toThrow(/Obsolete/);
      writeSnapshots(snapshots, outputDir);
      expect(existsSync(join(outputDir, "removed-coin.json"))).toBe(false);
      expect(checkSnapshots(outputDir)).toEqual(snapshots);
      expect(fetch).not.toHaveBeenCalled();
      expect(loadEnv).not.toHaveBeenCalled();
    } finally { rmSync(outputDir, { recursive: true, force: true }); }
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("carries body and header source clocks through snapshots rather than the build clock", async () => {
    credentials();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ price: 1, _meta: { updatedAt: 1_700_000_000 } }))
      .mockResolvedValueOnce(Response.json([], { headers: { Date: "Tue, 14 Nov 2023 22:13:20 GMT", "X-Data-Age": "3600", Age: "600" } })));
    const detail = await fetchDetail(), history = await fetchHistory();
    const snapshot = buildSnapshot({
      summary: projectStablecoinLiveSummary(detail!.data), history: history!.data,
      updatedAt: { liveSummary: detail!.updatedAt, supplyHistory: history!.updatedAt }, generatedAt: 1_700_100_000_000,
    });
    expect(snapshot.updatedAt).toEqual({ liveSummary: 1_700_000_000_000, supplyHistory: 1_699_995_800_000 });
  });

  it("prefers origin clocks over rewritten Date/ages and preserves body provenance first", async () => {
    credentials();
    const headers = { "X-Data-Updated-At": "1700000000.125", Date: new Date(1_800_000_000_000).toUTCString(), Age: "500", "X-Data-Age": "100" };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json([], { headers }))
      .mockResolvedValueOnce(Response.json({ price: 1, _meta: { updatedAt: 1_600_000_000 } }, { headers })));
    expect(await fetchHistory()).toEqual({ data: [], updatedAt: 1_700_000_000_125 });
    expect((await fetchDetail())?.updatedAt).toBe(1_600_000_000_000);
  });

  it.each(["", "invalid", "-1", "Infinity", "1e309", "0x10", ".5", "5.", "1..2", "1 2"])("retains payload without a malformed origin clock (%s) or legacy fallback", async (sourceClock) => {
    credentials();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([], { headers: { "X-Data-Updated-At": sourceClock, Date: new Date(1_700_000_000_000).toUTCString(), "X-Data-Age": "10", Age: "20" } })));
    await expect(fetchHistory()).resolves.toEqual({ data: [] });
  });

  it("projects only compact above-fold fields from the full response", () => {
    const detail = StablecoinDetailResponseSchema.parse({
      price: null, tokens: [{ date: 1_700_000_000, totalCirculatingUSD: { peggedUSD: 100 }, research: ["large"] }],
      research: ["not cached"], prose: "not cached",
    });
    const summary = projectStablecoinLiveSummary(detail);
    expect(summary.price).toBeNull();
    expect(summary.circulating).toEqual({ peggedUSD: 100 });
    for (const key of ["tokens", "research", "prose"]) expect(summary).not.toHaveProperty(key);
  });

  it("validates and preserves compact per-coin lanes", () => {
    const summary = liveSummary();
    const snapshot = buildSnapshot({ summary, history: [{ date: 1_700_000_000, circulatingUsd: 100, price: 1 }] });
    expect(validateSnapshot(snapshot)).toEqual(snapshot);
    expect(snapshot.lanes.liveSummary).toEqual(summary);
    expect(snapshot.lanes.supplyHistory).toHaveLength(1);
  });

  it("keeps partial-chain provenance with its original clocks and drops other provenance to fit the budget (K-031)", () => {
    const guard = {
      reason: "supply-chain-dropout" as const, status: "chains-unavailable" as const, partialCoverage: true as const, quarantinedSince: 1_699_000_000,
      chains: [{ chainLabel: "HyperEVM", listCurrentUsd: 0, baselineUsd: 3, baselineObservedAt: 1_698_900_000, baselineSource: "state" as const, resolution: "unavailable" as const }],
    };
    const partial = { supplySource: "defillama", supplyObservedAt: 1_699_999_000, supplyChainGuard: guard };
    const snapshot = buildSnapshot({
      summary: liveSummary(),
      history: [
        { date: 1_699_913_600, circulatingUsd: 100, price: 1, supplyProvenance: { supplySource: "defillama", supplyObservedAt: null, supplyChainGuard: null } },
        { date: 1_700_000_000, circulatingUsd: 97, price: 1, supplyProvenance: partial },
      ],
    });
    expect(validateSnapshot(snapshot)).toEqual(snapshot);
    expect(snapshot.lanes.supplyHistory![0]).not.toHaveProperty("supplyProvenance");
    expect(snapshot.lanes.supplyHistory![1]!.supplyProvenance).toEqual(partial);
  });

  it("rejects a generated compact lane that no longer matches its runtime schema", () => {
    expect(() => validateSnapshot({
      version: 1, stablecoinId: USDT, generatedAt: 1_700_000_000_000, lanes: { liveSummary: { price: "not-a-number" } },
    })).toThrow();
  });

  it("fails closed on upstream errors while allowing an explicitly absent lane", async () => {
    credentials();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockImplementation(async () => new Response("upstream unavailable", { status: 503 })));
    const warning = silence();
    await expect(fetchHistory("optional history")).resolves.toBeNull();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("HTTP 404"));
    vi.useFakeTimers();
    const failure = expect(fetchDetail("coin detail for usdt-tether")).rejects.toThrow("HTTP 503");
    await vi.runAllTimersAsync();
    await failure;
  });

  it("fails closed when a successful response does not match its lane schema", async () => {
    credentials();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ price: "invalid", tokens: [] })));
    await expect(fetchDetail("coin detail for usdt-tether")).rejects.toThrow();
  });

  it("keeps a representative compact summary and 90-day supply envelope within the target", () => {
    const history = Array.from({ length: 90 }, (_, i) => ({ date: 1_700_000_000 + i * 86_400, circulatingUsd: 100_000_000 + i * 10_000, price: 1 + i / 1_000_000 }));
    const snapshot = buildSnapshot({ summary: liveSummary(), history });
    expect(snapshot.lanes.liveSummary).toBeDefined();
    expect(snapshot.lanes.supplyHistory).toHaveLength(90);
    expect(serializedSnapshotBytes(snapshot)).toBeLessThanOrEqual(8 * 1024);
  });

  it("permits an empty envelope when both lanes exceed the cap", () => {
    silence();
    const oversizedBuckets = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`peggedUSD-${"x".repeat(30)}-${i}`, i]));
    const snapshot = buildSnapshot({ summary: liveSummary({ circulating: oversizedBuckets }), history: oversizedHistory() });
    expect(snapshot.lanes).toEqual({});
    expect(serializedSnapshotBytes(snapshot)).toBeLessThanOrEqual(8 * 1024);
  });

  it("adds the dated release assessment lane only where it fits beside the live lanes", () => {
    silence();
    const summary = liveSummary();
    const readScoresLatestRow = (id: string) => (id === USDT || id === USDC ? SCORES_ROW : null);
    const snapshots = buildSnapshots({
      generatedAt: 1_700_000_100_000, updatedAtById: new Map([[USDT, { liveSummary: 1_700_000_000_000 }]]),
      liveSummariesById: new Map([[USDT, summary], [USDC, summary]]), supplyHistoryById: new Map([[USDC, oversizedHistory()]]), readScoresLatestRow,
    });
    const usdt = snapshotFor(snapshots);
    const { asOfMs: _asOfMs, ...lane } = SCORES_ROW;
    expect(usdt.lanes).toEqual({ liveSummary: summary, safetyAssessment: lane });
    expect(usdt.updatedAt).toEqual({ liveSummary: 1_700_000_000_000, safetyAssessment: SCORES_ROW.asOfMs });
    expect(validateSnapshot(usdt)).toBe(usdt);
    expect(snapshotFor(snapshots, USDC).lanes).toEqual({ liveSummary: summary, safetyAssessment: lane });
    const unrated = snapshots.find((c) => readScoresLatestRow(c.stablecoinId) === null)!;
    expect(unrated.lanes).toEqual({});
    expect(unrated.updatedAt).toEqual({});
    expect(() => validateSnapshot({ ...usdt, updatedAt: { liveSummary: 1 } })).toThrow(/safety assessment lane is invalid or undated/);
  });

  it("compacts full-precision history so the dated assessment lane fits beside both live lanes", () => {
    const summary = liveSummary({ price: 0.007707534702047374, circulating: { peggedKES: 67_799.09458142496 } });
    const history = Array.from({ length: 90 }, (_, i) => ({
      date: 1_785_196_800 + i * 86_400, circulatingUsd: 163_174.16968380168 + i / 7, price: i === 0 ? null : 0.007662620215566711 + i / 3e9,
    }));
    history[1] = { ...history[1], circulatingUsd: 1e-9 };
    const updatedAt = laneClocks(1_700_000_000_000);
    const { asOfMs, ...assessment } = SCORES_ROW;
    const fullPrecisionBytes = serializedSnapshotBytes({
      version: 1, stablecoinId: USDT, generatedAt: 1_700_000_100_000,
      updatedAt: { ...updatedAt, safetyAssessment: asOfMs }, lanes: { liveSummary: summary, supplyHistory: history, safetyAssessment: assessment },
    });
    const warning = silence();
    const snapshot = buildSnapshot({ summary, history, updatedAt, generatedAt: 1_700_000_100_000, readScoresLatestRow: (id) => (id === USDT ? SCORES_ROW : null) });
    expect(warning).not.toHaveBeenCalled();
    expect(Object.keys(snapshot.lanes).sort()).toEqual(["liveSummary", "safetyAssessment", "supplyHistory"]);
    expect(serializedSnapshotBytes(snapshot)).toBeLessThanOrEqual(DETAIL_SNAPSHOT_TARGET_BYTES);
    expect(serializedSnapshotBytes(snapshot)).toBeLessThan(fullPrecisionBytes);
    const compacted = snapshot.lanes.supplyHistory!;
    expect(compacted).toHaveLength(90);
    expect(compacted[0].price).toBeNull();
    expect(compacted[1].circulatingUsd).toBe(1e-9);
    expect(compacted[2].circulatingUsd).toBe(Number(history[2].circulatingUsd.toPrecision(10)));
    for (const [i, pt] of compacted.entries()) {
      expect(pt.date).toBe(history[i].date);
      expect(Math.abs(pt.circulatingUsd - history[i].circulatingUsd)).toBeLessThanOrEqual(Math.abs(history[i].circulatingUsd) * 1e-9);
      if (pt.price !== null) expect(Math.abs(pt.price - history[i].price!)).toBeLessThanOrEqual(history[i].price! * 1e-9);
    }
  });

  it("retains a small summary when oversized history is removed", () => {
    silence();
    const summary = liveSummary();
    const snapshot = buildSnapshot({ summary, history: oversizedHistory() });
    expect(snapshot.lanes).toEqual({ liveSummary: summary });
    expect(serializedSnapshotBytes(snapshot)).toBeLessThanOrEqual(8 * 1024);
  });

  it("requires complete valid legacy age evidence without inventing receipt-time clocks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    credentials();
    const date = new Date(100_000).toUTCString();
    const cases: [Record<string, string>, number | null][] = [
      [{ "X-Data-Age": "10", Age: "20" }, null], [{ Date: "invalid", "X-Data-Age": "10", Age: "20" }, null],
      [{}, null], [{ Date: date }, null], [{ Date: date, "X-Data-Age": "10" }, null],
      [{ Date: date, Age: "20" }, null], [{ Date: date, "X-Data-Age": "invalid", Age: "invalid" }, null],
      ...["", "-1", "Infinity", "0x10", "1e2"].flatMap((v): [Record<string, string>, null][] => [
        [{ Date: date, "X-Data-Age": v, Age: "20" }, null], [{ Date: date, "X-Data-Age": "10", Age: v }, null],
      ]),
      [{ Date: date, "X-Data-Age": "10", Age: "20" }, 70_000],
      [{ Date: new Date(120_000).toUTCString(), "X-Data-Age": "10", Age: "40" }, 70_000],
      [{ Date: date, "X-Data-Age": "90", Age: "20" }, 0], [{ Date: date, "X-Data-Age": "0", Age: "0" }, 100_000],
    ];
    for (const [headers, expected] of cases) {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json([], { headers })));
      expect(await fetchHistory()).toEqual({ data: [], ...(expected !== null ? { updatedAt: expected } : {}) });
    }
  });

  it("rejects missing credentials before transport and malformed successful JSON", async () => {
    for (const name of ["PHAROS_API_KEY", "SITE_API_SHARED_SECRET", "DIGEST_API_KEY", "PUBLIC_DATASETS_API_KEY", "SMOKE_API_KEY"]) vi.stubEnv(name, "");
    const fetch = vi.fn(async () => new Response("malformed-json"));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchDetail()).rejects.toThrow(/required/);
    expect(fetch).not.toHaveBeenCalled();
    credentials();
    await expect(fetchDetail()).rejects.toBeInstanceOf(SyntaxError);
  });

  it("refuses to generate an empty envelope for a live stablecoin", async () => {
    credentials();
    clearApiUrls();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    silence();
    await expect(generateSnapshots(false)).rejects.toThrow(/No detail snapshot lanes were available/);
  });

  it("fetches live IDs but preserves empty envelopes for non-live catalog members", async () => {
    credentials();
    clearApiUrls();
    const requested = new Set<string>();
    let open = 0, peak = 0;
    vi.stubGlobal("fetch", vi.fn(async (raw: string) => {
      const { history, id } = coinRequest(raw);
      requested.add(id);
      open++; peak = Math.max(peak, open);
      const res = Response.json(history ? [] : { price: 1 });
      const consume = res.json.bind(res);
      vi.spyOn(res, "json").mockImplementation(async () => { await Promise.resolve(); const d = await consume(); open--; return d; });
      return res;
    }));
    const snapshots = await generateSnapshots(false);
    const nonLive = COINS.filter((c) => c.status != null && c.status !== "active" && c.status !== "frozen");
    expect(nonLive.length).toBeGreaterThan(0);
    for (const coin of nonLive) {
      expect(requested.has(coin.id)).toBe(false);
      expect(snapshotFor(snapshots, coin.id)?.lanes).toEqual({});
    }
    expect(peak).toBeLessThanOrEqual(6);
    expect(requested.has(USDT)).toBe(true);
    expect(snapshotFor(snapshots)?.lanes).toMatchObject({ liveSummary: { price: 1 }, supplyHistory: [] });
    expect(snapshots.map((s) => s.stablecoinId)).toEqual(COINS.map((c) => c.id));
  });

  it("publishes healthy and unproven lanes without using the artifact clock as source provenance", async () => {
    credentials();
    clearApiUrls();
    vi.stubGlobal("fetch", vi.fn(async (raw: string) => {
      const { history, id } = coinRequest(raw);
      return Response.json(history ? [] : { price: 1 }, { headers: id === USDT && !history ? {} : { "X-Data-Updated-At": "1700000000" } });
    }));
    const snapshots = await generateSnapshots(false, { source: "per-coin", generatedAt: 1_700_000_100_000 });
    const unproven = snapshotFor(snapshots);
    expect(unproven.lanes).toMatchObject({ liveSummary: { price: 1 }, supplyHistory: [] });
    expect(unproven.updatedAt).toEqual({ supplyHistory: 1_700_000_000_000 });
    expect(snapshotFor(snapshots, USDC)?.updatedAt).toEqual(laneClocks(1_700_000_000_000));
    expect(reportAges([unproven], unproven.generatedAt)).toContain("unavailable clocks=1; no summary lane=0");
  });

  it.each([false, true])("produces identical bulk bytes and falls back only for unavailable coins (originClock=%s)", async (originClock) => {
    const log = silence("log");
    credentials("fixture-key", "fixture-site-secret");
    vi.stubEnv("PHAROS_DETAIL_SNAPSHOT_SOURCE", "per-coin");
    clearApiUrls();
    const now = 1_800_000_000_000;
    const sourceClock = 1_799_999_900;
    const day = 86_400;
    const detail = { price: 1, priceSource: "coingecko",
      currentSupplyObservedAt: sourceClock, currentCirculatingUSD: { peggedUSD: 200 }, currentCirculatingNative: 200, tokens: [[33, 50], [30, 80], [10, 100], [7, 140], [3, 160]].map(([days, supply]) => ({
        date: sourceClock - days * day, totalCirculatingUSD: { peggedUSD: supply }, totalCirculating: { peggedUSD: supply },
      })) };
    const history = [{ date: sourceClock, circulatingUsd: 100, price: 1 }];
    // Freeze the run clock: the legacy path now refuses an origin `Date` beyond
    // the shared future-skew allowance, so the fixture header must be the edge
    // receipt time of this run rather than a future instant.
    vi.spyOn(Date, "now").mockReturnValue(now);
    // Origin provenance also survives the one-second loss in legacy Date/age arithmetic:
    // edge receipt (`now`) minus edge residence (100 s) is the origin clock.
    const headers = new Headers({ Date: new Date(now).toUTCString(), Age: "100", "X-Data-Age": "0" });
    if (originClock) headers.set("X-Data-Updated-At", String(sourceClock));
    const perCoinIds: string[] = [];
    const batches: string[][] = [];
    const unavailableId = USDT;
    const unavailableIds = [unavailableId, ...LIVE_IDS.filter((id) => id !== USDT && id !== USDC).slice(0, 3)];
    let pendingBulkBodies = 0, peakBulkBodies = 0, completedBatches = 0, peakCoins = 0, peakSockets = 0, openSockets = 0;
    const pendingCoins = new Map<string, Set<string>>();
    let retryPending = originClock;
    let sawConcurrentLanes = false;
    const expectedBatches = Math.ceil(LIVE_IDS.length / BATCH_SIZE);
    silence();
    vi.stubGlobal("fetch", vi.fn(async (raw: string) => {
      const { url, history: isHistory, id } = coinRequest(raw);
      if (url.pathname.endsWith("/stablecoin-detail-snapshot-inputs")) {
        expect(url.hostname).toBe("site-api.pharos.watch");
        const ids = url.searchParams.get("ids")!.split(",");
        batches.push(ids);
        pendingBulkBodies++;
        peakBulkBodies = Math.max(peakBulkBodies, pendingBulkBodies);
        expect(pendingBulkBodies).toBeLessThanOrEqual(6);
        const response = Response.json({ version: 1, entries: ids.map((id) => {
          const sources = { detailCacheUpdatedAt: sourceClock, publicationUpdatedAt: sourceClock, supplySnapshotUpdatedAt: sourceClock, supplySnapshotDate: sourceClock };
          return unavailableIds.includes(id)
            ? { id, status: "unavailable", reason: id === unavailableId ? "detail-cache-missing" : "publication-unavailable", sources }
            : bulkEntry(id, sourceClock * 1000, {
              liveSummary: projectStablecoinLiveSummary(StablecoinDetailResponseSchema.parse(detail), id), supplyHistory: history,
              freshness: { liveSummary: { status: "fresh", maxAgeSec: 300 }, supplyHistory: { status: "fresh", maxAgeSec: 86_400 } },
            });
        }) });
        const consumeBody = response.json.bind(response);
        vi.spyOn(response, "json").mockImplementation(async () => {
          await Promise.resolve();
          const body = await consumeBody();
          pendingBulkBodies--;
          completedBatches++;
          return body;
        });
        return response;
      }
      perCoinIds.push(id);
      const response = Response.json(isHistory ? history : detail, { headers });
      if (!batches.length) return response;
      expect(completedBatches).toBe(expectedBatches);
      const lane = isHistory ? "history" : "detail";
      const lanes = pendingCoins.get(id) ?? new Set<string>();
      lanes.add(lane);
      pendingCoins.set(id, lanes);
      if (lanes.size === 2) sawConcurrentLanes = true;
      peakCoins = Math.max(peakCoins, pendingCoins.size);
      if (retryPending && id === unavailableId && !isHistory) {
        retryPending = false;
        return new Response(null, { status: 503 });
      }
      openSockets++;
      peakSockets = Math.max(peakSockets, openSockets);
      const consumeBody = response.json.bind(response);
      vi.spyOn(response, "json").mockImplementation(async () => {
        await Promise.resolve();
        const body = await consumeBody();
        openSockets--;
        lanes.delete(lane);
        if (lanes.size === 0) pendingCoins.delete(id);
        return body;
      });
      return response;
    }));
    const baseline = await generateSnapshots(false, { generatedAt: now });
    perCoinIds.length = 0;
    vi.stubEnv("PHAROS_DETAIL_SNAPSHOT_SOURCE", "bulk");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const [bulk] = await Promise.all([generateSnapshots(false, { generatedAt: now }), vi.runAllTimersAsync()]);
    expect(bulk.map((snapshot) => `${JSON.stringify(snapshot)}\n`))
      .toEqual(baseline.map((snapshot) => `${JSON.stringify(snapshot)}\n`));
    const acquisition = JSON.parse(log.mock.calls.at(-1)![0] as string).detailSnapshotAcquisition;
    expect(entryFor(acquisition.entries, unavailableId)).toMatchObject({
      source: "bulk-unavailable-fallback", reason: "detail-cache-missing",
      updatedAt: { liveSummary: sourceClock * 1000 }, bulkSources: { detailCacheUpdatedAt: sourceClock },
    });
    expect(entryFor(acquisition.entries, USDC)).toMatchObject({
      source: "bulk-cache-only", updatedAt: { liveSummary: sourceClock * 1000 },
    });
    for (const snapshots of [baseline, bulk]) {
      expect(snapshotFor(snapshots, USDC)?.lanes.liveSummary).toMatchObject({
        circulatingPrevWeek: { peggedUSD: 140 }, circulatingPrevMonth: { peggedUSD: 80 },
        nativeSupply: { current: 200, prevWeek: 140, prevMonth: 80 },
      });
    }
    expect(perCoinIds.sort()).toEqual([
      ...unavailableIds.flatMap((id) => [id, id]), ...(originClock ? [unavailableId] : []),
    ].sort());
    expect(sawConcurrentLanes).toBe(true);
    expect(peakCoins).toBe(3);
    expect(peakSockets).toBeLessThanOrEqual(6);
    expect(pendingCoins.size).toBe(0);
    expect(peakBulkBodies).toBe(6);
    expect(pendingBulkBodies).toBe(0);
    expect(BATCH_SIZE).toBe(20);
    expect(batches[0]).toHaveLength(BATCH_SIZE);
    expect(batches.every((ids) => ids.length <= BATCH_SIZE)).toBe(true);
    expect(batches.flat()).toEqual(LIVE_IDS);
  });

  it("splits bulk batches to legacy size 10 on HTTP 400 and remembers the cap", async () => {
    credentials("fixture-key", "fixture-site-secret");
    clearApiUrls();
    silence("log");
    const warn = silence();
    const now = 1_800_000_000_000;
    const requestedSizes: number[] = [];
    const rejected: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (raw: string) => {
      const url = new URL(raw);
      const ids = url.searchParams.get("ids")!.split(",");
      requestedSizes.push(ids.length);
      if (ids.length > LEGACY_BATCH_SIZE) {
        rejected.push(ids.length);
        return new Response("max 10", { status: 400 });
      }
      return bulkResponse(url, (id) => bulkEntry(id, now - 60_000));
    }));
    const snapshots = await generateSnapshots(false, { source: "bulk", generatedAt: now });
    expect(snapshots).toHaveLength(COINS.length);
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected.length).toBeLessThanOrEqual(6);
    expect(requestedSizes.filter((size) => size <= LEGACY_BATCH_SIZE).reduce((a, b) => a + b, 0)).toBe(LIVE_IDS.length);
    expect(warn).toHaveBeenCalledTimes(1);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad id", { status: 400 })));
    await expect(generateSnapshots(false, { source: "bulk", generatedAt: now })).rejects.toThrow(/HTTP 400/);
  });

  it("keeps credentialless bulk-configured Pages releases on per-coin acquisition", async () => {
    credentials("", "");
    vi.spyOn(process, "loadEnvFile").mockImplementation(() => undefined);
    clearApiUrls();
    const warn = silence();
    const fetch = vi.fn(async (raw: string) => {
      const url = new URL(raw);
      expect(url.pathname).toMatch(/^\/_site-data\/(stablecoin\/|supply-history)/);
      return Response.json(url.pathname.endsWith("/supply-history") ? [] : { price: 1, tokens: [] });
    });
    vi.stubGlobal("fetch", fetch);
    const snapshots = await generateSnapshots(false, { source: "bulk" });
    expect(snapshots).toHaveLength(COINS.length);
    expect(fetch).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("using per-coin acquisition"));
  });

  it("rejects malformed or incomplete bulk accounting without silently falling back", async () => {
    credentials("fixture-key", "fixture-site-secret");
    clearApiUrls();
    const fetch = vi.fn(async () => Response.json({ version: 1, entries: [{
      id: "not-requested", status: "unavailable", reason: "detail-cache-missing",
      sources: EMPTY_SOURCES,
    }] }));
    vi.stubGlobal("fetch", fetch);
    await expect(generateSnapshots(false, { source: "bulk" })).rejects.toThrow(/account for every requested coin/);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it("reads only the history lane for unavailable inactive rows and inlines history-only bulk entries", async () => {
    credentials("fixture-key", "fixture-site-secret");
    clearApiUrls();
    const log = silence("log");
    silence();
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const [frozenId, inlineFrozenId] = COINS.filter((coin) => coin.status === "frozen").map((coin) => coin.id);
    const activeId = COINS.find((coin) => coin.status == null || coin.status === "active")!.id;
    const sources = EMPTY_SOURCES, perCoin: string[] = [];
    let historyAvailable = true;
    vi.stubGlobal("fetch", vi.fn(async (raw: string) => {
      const { url, history, id } = coinRequest(raw);
      if (url.pathname.endsWith("/stablecoin-detail-snapshot-inputs")) {
        return bulkResponse(url, (id) => id === inlineFrozenId
          ? { id, status: "history-only", reason: "detail-cache-missing", supplyHistory: [], updatedAt: { supplyHistory: 1_799_999_900_000 },
            freshness: { supplyHistory: { status: "fresh", maxAgeSec: 86_400 } }, sources }
          : id === frozenId || id === activeId
            ? { id, status: "unavailable", reason: "detail-cache-missing", sources }
            : bulkEntry(id, now - 60_000));
      }
      perCoin.push(`${history ? "history" : "detail"}:${id}`);
      if (!historyAvailable) return new Response("", { status: 404 });
      return Response.json(history ? [] : { price: 1 }, { headers: { "X-Data-Updated-At": "1799999900" } });
    }));
    const snapshots = await generateSnapshots(false, { source: "bulk", generatedAt: now });
    expect(perCoin).not.toContain(`detail:${frozenId}`);
    expect(perCoin).not.toContain(`detail:${inlineFrozenId}`);
    expect(perCoin).not.toContain(`history:${inlineFrozenId}`);
    expect(perCoin).toContain(`history:${frozenId}`);
    expect(perCoin).toContain(`detail:${activeId}`);
    expect(snapshotFor(snapshots, frozenId)).toMatchObject({ lanes: { supplyHistory: [] }, updatedAt: { supplyHistory: 1_799_999_900_000 } });
    expect(snapshotFor(snapshots, inlineFrozenId)).toMatchObject({ lanes: { supplyHistory: [] }, updatedAt: { supplyHistory: 1_799_999_900_000 } });
    const evidence = JSON.parse(log.mock.calls[0][0] as string).detailSnapshotAcquisition;
    expect(entryFor(evidence.entries, inlineFrozenId)).toMatchObject({ source: "bulk-history-only", reason: "detail-cache-missing", updatedAt: { supplyHistory: 1_799_999_900_000 } });
    expect(entryFor(evidence.entries, frozenId)).toMatchObject({ source: "bulk-unavailable-history-only", reason: "detail-cache-missing", updatedAt: { supplyHistory: 1_799_999_900_000 } });
    expect(entryFor(evidence.entries, activeId)).toMatchObject({ source: "bulk-unavailable-fallback" });
    historyAvailable = false;
    await expect(generateSnapshots(false, { source: "bulk", generatedAt: now })).rejects.toThrow(/No detail snapshot lanes were available/);
  });

  it("matches empty inline history-only snapshots byte-for-byte with history-only per-coin fallback on unknown clock", async () => {
    credentials("fixture-key", "fixture-site-secret");
    clearApiUrls();
    const log = silence("log");
    silence();
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const frozenId = COINS.find((coin) => coin.status === "frozen")!.id;
    const inlineEmptyEntry: DetailSnapshotInputEntry = {
      id: frozenId,
      status: "history-only",
      reason: "detail-cache-missing",
      supplyHistory: [],
      updatedAt: {},
      freshness: { supplyHistory: { status: "unknown", reason: "empty-supply-history", maxAgeSec: 86_400 } },
      sources: EMPTY_SOURCES,
    };
    expect(DetailSnapshotInputsResponseSchema.safeParse({ version: 1, entries: [inlineEmptyEntry] }).success).toBe(true);
    expect(DetailSnapshotInputsResponseSchema.safeParse({
      version: 1,
      entries: [{ ...inlineEmptyEntry, freshness: { supplyHistory: { status: "unknown", maxAgeSec: 86_400 } } }],
    }).success).toBe(false);
    expect(DetailSnapshotInputsResponseSchema.safeParse({
      version: 1,
      entries: [{ ...inlineEmptyEntry, updatedAt: { supplyHistory: null } }],
    }).success).toBe(false);

    let mode: "fallback" | "inline" = "fallback";
    const perCoin: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (raw: string) => {
      const { url, history, id } = coinRequest(raw);
      if (url.pathname.endsWith("/stablecoin-detail-snapshot-inputs")) {
        return bulkResponse(url, (entryId) => entryId === frozenId
          ? (mode === "inline"
            ? inlineEmptyEntry
            : { id: entryId, status: "unavailable", reason: "detail-cache-missing", sources: EMPTY_SOURCES })
          : bulkEntry(entryId, now - 60_000));
      }
      perCoin.push(`${history ? "history" : "detail"}:${id}`);
      return Response.json([], { headers: { "X-Data-Updated-At": "unknown" } });
    }));

    const fallbackSnapshots = await generateSnapshots(false, { source: "bulk", generatedAt: now });
    expect(perCoin).toEqual([`history:${frozenId}`]);
    perCoin.length = 0;

    mode = "inline";
    const inlineSnapshots = await generateSnapshots(false, { source: "bulk", generatedAt: now });
    expect(perCoin).toEqual([]);

    const fallbackSnapshot = snapshotFor(fallbackSnapshots, frozenId);
    const inlineSnapshot = snapshotFor(inlineSnapshots, frozenId);
    expect(JSON.stringify(inlineSnapshot)).toBe(JSON.stringify(fallbackSnapshot));
    expect(inlineSnapshot).toEqual({
      version: 1,
      stablecoinId: frozenId,
      generatedAt: now,
      updatedAt: {},
      lanes: { supplyHistory: [] },
    });
    expect("supplyHistory" in inlineSnapshot.updatedAt).toBe(false);
    expect(validateSnapshot(inlineSnapshot)).toEqual(inlineSnapshot);
    const evidence = JSON.parse(log.mock.calls.at(-1)![0] as string).detailSnapshotAcquisition;
    expect(entryFor(evidence.entries, frozenId)).toMatchObject({
      source: "bulk-history-only",
      reason: "detail-cache-missing",
      updatedAt: {},
      bulkUpdatedAt: {},
    });
  });

});

describe("bounded stale bulk refresh", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("selects only producer ages strictly above the UI stale band, oldest first with a deterministic cap", () => {
    const now = 1_800_000_000_000, boundary = now - UI_STALE_MS;
    const entries: DetailSnapshotInputEntry[] = [
      bulkEntry("fresh", now - 600_001), bulkEntry("at-boundary", boundary), bulkEntry("old-b", boundary - 1),
      bulkEntry("oldest", boundary - 1000), bulkEntry("old-a", boundary - 1),
      { id: "unavailable", status: "unavailable", reason: "detail-cache-missing", sources: EMPTY_SOURCES },
    ];
    expect(UI_STALE_MS).toBe(120 * 60_000);
    expect(selectRefreshIds(entries, now, 2)).toEqual(["oldest", "old-a"]);
    expect(selectRefreshIds(entries, now, 0)).toEqual([]);
    expect(selectRefreshIds(Array.from({ length: 30 }, (_, i) => bulkEntry(`coin-${i}`, boundary - 1)), now)).toHaveLength(DETAIL_SNAPSHOT_STALE_REFRESH_LIMIT);
    for (const cap of [-1, 1.5, DETAIL_SNAPSHOT_STALE_REFRESH_LIMIT + 1]) expect(() => selectRefreshIds(entries, now, cap)).toThrow(/refresh limit/);
  });

  it("refreshes the selected rows after bulk bodies finish and records actual paths and clocks without re-stamping old rows", async () => {
    credentials("", "fixture-site-secret"); clearApiUrls();
    const log = silence("log"); silence();
    const now = 1_800_000_000_000, [refreshedId, retainedId, cappedId] = LIVE_IDS;
    const sourceClocks: Record<string, number> = { [refreshedId]: now - UI_STALE_MS - 3000, [retainedId]: now - UI_STALE_MS - 2000, [cappedId]: now - UI_STALE_MS - 1000 };
    const perCoinIds: string[] = [];
    let pendingBodies = 0, peakBodies = 0, bulkCompleted = 0, failRefresh = false;
    const expectedBatches = Math.ceil(LIVE_IDS.length / BATCH_SIZE);
    vi.stubGlobal("fetch", vi.fn(async (raw: string, init: RequestInit) => {
      const { url, history, id } = coinRequest(raw);
      expect(url.hostname).toBe("site-api.pharos.watch");
      expect(new Headers(init.headers).get("X-Pharos-Site-Proxy-Secret")).toBe("fixture-site-secret");
      const bulk = url.pathname.endsWith("/stablecoin-detail-snapshot-inputs");
      pendingBodies++; peakBodies = Math.max(peakBodies, pendingBodies);
      expect(pendingBodies).toBeLessThanOrEqual(6);
      let response: Response;
      if (bulk) response = bulkResponse(url, (id) => bulkEntry(id, sourceClocks[id] ?? now - 60_000));
      else {
        expect(bulkCompleted % expectedBatches).toBe(0);
        expect(history).toBe(false);
        perCoinIds.push(id);
        const clock = id === refreshedId ? now - 30_000 : sourceClocks[id];
        response = Response.json({ price: failRefresh ? "invalid" : 2 }, { headers: { "X-Data-Updated-At": String(clock / 1000) } });
      }
      const consume = response.json.bind(response);
      vi.spyOn(response, "json").mockImplementation(async () => { await Promise.resolve(); const data = await consume(); pendingBodies--; if (bulk) bulkCompleted++; return data; });
      return response;
    }));
    const snapshots = await generateSnapshots(false, { source: "bulk", generatedAt: now, staleRefreshLimit: 2 });
    const snapshot = (id: string) => snapshotFor(snapshots, id);
    expect(snapshot(refreshedId).updatedAt).toEqual({ liveSummary: now - 30_000, supplyHistory: sourceClocks[refreshedId] });
    expect(snapshot(refreshedId).lanes.liveSummary?.price).toBe(2);
    expect(snapshot(refreshedId).lanes.supplyHistory).toEqual([]);
    expect(snapshot(retainedId).updatedAt.liveSummary).toBe(sourceClocks[retainedId]);
    expect(snapshot(cappedId).updatedAt.liveSummary).toBe(sourceClocks[cappedId]);
    expect(snapshot(cappedId).lanes.liveSummary?.price).toBe(1);
    expect(perCoinIds.sort()).toEqual([refreshedId, retainedId].sort());
    expect(pendingBodies).toBe(0);
    expect(peakBodies).toBe(6);
    const evidence = JSON.parse(log.mock.calls[0][0] as string).detailSnapshotAcquisition;
    expect(evidence).toMatchObject({ assessedAt: now, staleCandidateCount: 3, staleRefreshLimit: 2, staleRefreshBudgetMs: UI_STALE_MS });
    expect(entryFor(evidence.entries, refreshedId)).toMatchObject({
      source: "bulk-stale-refresh", bulkUpdatedAt: { liveSummary: sourceClocks[refreshedId] },
      updatedAt: { liveSummary: now - 30_000 }, bulkSources: { detailCacheUpdatedAt: sourceClocks[refreshedId] / 1000 },
    });
    expect(entryFor(evidence.entries, retainedId)).toMatchObject({ source: "bulk-stale-refresh", updatedAt: { liveSummary: sourceClocks[retainedId] } });
    expect(entryFor(evidence.entries, cappedId)).toMatchObject({ source: "bulk-cache-only", updatedAt: { liveSummary: sourceClocks[cappedId] } });
    expect(snapshot(refreshedId)).not.toHaveProperty("acquisition");
    failRefresh = true;
    await expect(generateSnapshots(false, { source: "bulk", generatedAt: now, staleRefreshLimit: 2 })).rejects.toThrow();
  });

  it("spends the stale-refresh cap on refreshable records, never on a non-active row", async () => {
    credentials("", "fixture-site-secret"); clearApiUrls();
    const log = silence("log"); silence();
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const frozenId = COINS.find((c) => c.status === "frozen")!.id;
    const activeIds = COINS.filter((c) => c.status == null || c.status === "active").slice(0, 3).map((c) => c.id);
    const staleClocks = new Map<string, number>([[frozenId, now - UI_STALE_MS - 4000], ...activeIds.map((id, i) => [id, now - UI_STALE_MS - 3000 + i * 1000] as const)]);
    const perCoin: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (raw: string) => {
      const { url, history, id } = coinRequest(raw);
      if (url.pathname.endsWith("/stablecoin-detail-snapshot-inputs")) return bulkResponse(url, (id) => bulkEntry(id, staleClocks.get(id) ?? now - 60_000));
      perCoin.push(`${history ? "history" : "detail"}:${id}`);
      return Response.json(history ? [] : { price: 2 }, { headers: { "X-Data-Updated-At": String((now - 30_000) / 1000) } });
    }));
    const snapshots = await generateSnapshots(false, { source: "bulk", generatedAt: now, staleRefreshLimit: 2 });
    const snapshot = (id: string) => snapshotFor(snapshots, id);
    expect(perCoin.sort()).toEqual(activeIds.slice(0, 2).map((id) => `detail:${id}`).sort());
    expect(snapshot(frozenId).updatedAt.liveSummary).toBe(staleClocks.get(frozenId));
    expect(snapshot(frozenId).lanes.liveSummary?.price).toBe(1);
    for (const id of activeIds.slice(0, 2)) {
      expect(snapshot(id).updatedAt).toEqual({ liveSummary: now - 30_000, supplyHistory: staleClocks.get(id) });
      expect(snapshot(id).lanes.liveSummary?.price).toBe(2);
    }
    expect(snapshot(activeIds[2]).updatedAt.liveSummary).toBe(staleClocks.get(activeIds[2]));
    const evidence = JSON.parse(log.mock.calls[0][0] as string).detailSnapshotAcquisition;
    expect(evidence).toMatchObject({ staleCandidateCount: 4, staleRefreshLimit: 2 });
    expect(entryFor(evidence.entries, frozenId)).toMatchObject({ source: "bulk-cache-only", updatedAt: { liveSummary: staleClocks.get(frozenId) } });
    expect(entryFor(evidence.entries, activeIds[2])).toMatchObject({ source: "bulk-cache-only" });
    expect(entryFor(evidence.entries, activeIds[1])).toMatchObject({ source: "bulk-stale-refresh" });
  });

  it("allows 6 concurrent 1-socket stale refreshes and bounds mixed 1- and 2-socket fallbacks to <= 6 sockets in FIFO order", async () => {
    credentials("", "fixture-site-secret");
    clearApiUrls();
    const log = silence("log");
    silence();
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const activeIds = COINS.filter((c) => c.status == null || c.status === "active").slice(0, 8).map((c) => c.id);
    const [frozenFallbackId, frozenInlineId] = COINS.filter((c) => c.status === "frozen").map((c) => c.id);
    const delayTick = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

    // Part 1: 8 single-socket stale refreshes fill all 6 semaphore permits concurrently.
    const staleOnlyClocks = new Map(activeIds.map((id, i) => [id, now - UI_STALE_MS - (8 - i) * 1000]));
    let openSockets = 0, peakSockets = 0;
    vi.stubGlobal("fetch", vi.fn(async (raw: string) => {
      const { url, history } = coinRequest(raw);
      if (url.pathname.endsWith("/stablecoin-detail-snapshot-inputs")) {
        return bulkResponse(url, (id) => bulkEntry(id, staleOnlyClocks.get(id) ?? now - 60_000));
      }
      expect(history).toBe(false);
      openSockets++;
      peakSockets = Math.max(peakSockets, openSockets);
      expect(openSockets).toBeLessThanOrEqual(6);
      const response = Response.json({ price: 2 }, { headers: { "X-Data-Updated-At": String((now - 30_000) / 1000) } });
      const consume = response.json.bind(response);
      vi.spyOn(response, "json").mockImplementation(async () => {
        await delayTick();
        const body = await consume();
        openSockets--;
        return body;
      });
      return response;
    }));
    const refreshOnlySnapshots = await generateSnapshots(false, { source: "bulk", generatedAt: now, staleRefreshLimit: 8 });
    expect(peakSockets).toBe(6);
    expect(openSockets).toBe(0);
    expect(refreshOnlySnapshots.map((s) => s.stablecoinId)).toEqual(COINS.map((c) => c.id));

    // Part 2: Mixed 1-socket refreshes, 1-socket history-only fallback, 2-socket full fallbacks,
    // and 0-socket cache-only/history-only entries stay <= 6 sockets without starving 2-socket waiters.
    // Catalog order of activeIds[0..6]: [1, 2, 1, 2] (= 6 permits) followed by [2, 1, 2] queued FIFO.
    const twoSocketIds = new Set([activeIds[1], activeIds[3], activeIds[4], activeIds[6]]);
    const mixedStaleIds = new Set([activeIds[0], activeIds[2], activeIds[5]]);
    openSockets = 0;
    peakSockets = 0;
    const startOrder: string[] = [];
    const seenStart = new Set<string>();
    vi.stubGlobal("fetch", vi.fn(async (raw: string) => {
      const { url, history, id } = coinRequest(raw);
      if (url.pathname.endsWith("/stablecoin-detail-snapshot-inputs")) {
        return bulkResponse(url, (entryId) => {
          if (entryId === frozenInlineId) {
            return {
              id: entryId, status: "history-only", reason: "detail-cache-missing", supplyHistory: [], updatedAt: {},
              freshness: { supplyHistory: { status: "unknown", reason: "empty-supply-history", maxAgeSec: 86_400 } },
              sources: EMPTY_SOURCES,
            };
          }
          if (entryId === frozenFallbackId || twoSocketIds.has(entryId)) {
            return { id: entryId, status: "unavailable", reason: "detail-cache-missing", sources: EMPTY_SOURCES };
          }
          return bulkEntry(entryId, mixedStaleIds.has(entryId) ? now - UI_STALE_MS - 5000 : now - 60_000);
        });
      }
      if (!seenStart.has(id)) {
        seenStart.add(id);
        startOrder.push(id);
      }
      openSockets++;
      peakSockets = Math.max(peakSockets, openSockets);
      expect(openSockets).toBeLessThanOrEqual(6);
      const response = Response.json(history ? [] : { price: 2 }, { headers: { "X-Data-Updated-At": String((now - 30_000) / 1000) } });
      const consume = response.json.bind(response);
      vi.spyOn(response, "json").mockImplementation(async () => {
        await delayTick();
        const body = await consume();
        openSockets--;
        return body;
      });
      return response;
    }));
    const mixedSnapshots = await generateSnapshots(false, { source: "bulk", generatedAt: now, staleRefreshLimit: 8 });
    expect(peakSockets).toBe(6);
    expect(openSockets).toBe(0);
    // FIFO anti-starvation: 2-socket activeIds[4] is queued ahead of 1-socket activeIds[5] and must start first.
    expect(startOrder.indexOf(activeIds[4])).toBeGreaterThan(-1);
    expect(startOrder.indexOf(activeIds[5])).toBeGreaterThan(-1);
    expect(startOrder.indexOf(activeIds[4])).toBeLessThan(startOrder.indexOf(activeIds[5]));
    expect(startOrder).not.toContain(frozenInlineId);
    expect(startOrder).toContain(frozenFallbackId);
    expect(mixedSnapshots.map((s) => s.stablecoinId)).toEqual(COINS.map((c) => c.id));
    const mixedEvidence = JSON.parse(log.mock.calls.at(-1)![0] as string).detailSnapshotAcquisition;
    expect(mixedEvidence.entries.map((e: { id: string }) => e.id)).toEqual(LIVE_IDS);
  });

  it("reports producer-age percentiles and the UI budget without substituting artifact time or unavailable clocks", () => {
    const now = 1_800_000_000_000;
    const snapshots = buildSnapshots({
      generatedAt: now, liveSummariesById: new Map(COINS.slice(0, 4).map((c) => [c.id, liveSummary()])),
      updatedAtById: new Map(COINS.slice(0, 3).map((c, i) => [c.id, { liveSummary: now - [60_000, UI_STALE_MS, UI_STALE_MS + 60_000][i] }])),
    });
    expect(reportAges(snapshots, now)).toContain("max=121.0 min, p50=120.0 min, p95=121.0 min");
    expect(reportAges(snapshots, now)).toContain("above UI stale budget 120 min: 1/3; unavailable clocks=1");
    expect(reportAges(snapshots, now)).toContain(`oldestProducerAt=${new Date(now - UI_STALE_MS - 60_000).toISOString()}`);
    expect(reportAges([], now)).toContain("max=unavailable, p50=unavailable, p95=unavailable");
    for (const clock of [0, -1, Number.NaN, now + 1]) {
      const s = { version: 1 as const, stablecoinId: USDT, generatedAt: now, lanes: { liveSummary: liveSummary() }, updatedAt: { liveSummary: clock } };
      expect(reportAges([s], now)).toContain("max=unavailable");
      expect(reportAges([s], now)).toContain("unavailable clocks=1");
    }
  });
});
