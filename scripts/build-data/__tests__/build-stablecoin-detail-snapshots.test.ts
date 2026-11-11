import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRACKED_STABLECOINS as COINS } from "@shared/lib/stablecoins/registry";
import { StablecoinDetailResponseSchema, SupplyHistoryResponseSchema, type SupplyHistoryPoint } from "@shared/types/market";
import { projectStablecoinLiveSummary } from "@shared/lib/stablecoin-live-summary";
import { readDetailSnapshot } from "../../../src/lib/stablecoin-detail-snapshot-reader";
import type { StablecoinLiveSummary } from "@shared/types/stablecoin-live-summary";
import { DETAIL_SNAPSHOT_INPUT_BATCH_SIZE as BATCH_SIZE, type DetailSnapshotInputEntry } from "@shared/types/detail-snapshot-inputs";
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
    price: 1,
    priceSource: null,
    priceConfidence: null,
    priceUpdatedAt: null,
    priceObservedAt: null,
    supplyObservedAt: 1_700_000_000,
    circulating: { peggedUSD: 100 },
    circulatingPrevDay: { peggedUSD: 99 },
    circulatingPrevWeek: { peggedUSD: 98 },
    circulatingPrevMonth: { peggedUSD: 97 },
    nativeSupply: { current: 100, prevWeek: 98, prevMonth: 97 },
    ...overrides,
  };
}

const DETAIL_URL = "https://api.pharos.watch/api/stablecoin/usdt-tether";
const HISTORY_URL = "https://api.pharos.watch/api/supply-history";
const API_URL_ENVS = ["DIGEST_API_URL", "PUBLIC_DATASETS_API_URL", "SMOKE_API_BASE", "API_BASE_URL"];
const EMPTY_SOURCES = { detailCacheUpdatedAt: null, publicationUpdatedAt: null, supplySnapshotUpdatedAt: null, supplySnapshotDate: null };
const LIVE_IDS = COINS
  .filter((coin) => coin.status == null || coin.status === "active" || coin.status === "frozen").map((coin) => coin.id);

function credentials(apiKey = "fixture-key", siteSecret?: string): void {
  vi.stubEnv("PHAROS_API_KEY", apiKey);
  if (siteSecret !== undefined) vi.stubEnv("SITE_API_SHARED_SECRET", siteSecret);
}

function clearApiUrls(): void {
  for (const name of API_URL_ENVS) vi.stubEnv(name, "");
}

function buildSnapshots(inputs: Partial<SnapshotInputs> = {}) {
  return buildStablecoinDetailSnapshots({
    generatedAt: 1_700_000_000_000, liveSummariesById: new Map(),
    supplyHistoryById: new Map(), updatedAtById: new Map(), ...inputs,
  });
}

function buildSnapshot({ summary, history, updatedAt, ...inputs }: Partial<SnapshotInputs> & {
  summary: StablecoinLiveSummary; history: SupplyHistoryPoint[]; updatedAt?: { liveSummary?: number; supplyHistory?: number };
}) {
  return buildSnapshots({
    liveSummariesById: new Map([[USDT, summary]]),
    supplyHistoryById: new Map([[USDT, history]]),
    updatedAtById: updatedAt === undefined ? new Map() : new Map([[USDT, updatedAt]]), ...inputs,
  }).find((snapshot) => snapshot.stablecoinId === USDT)!;
}

function fetchDetail(label = "detail") {
  return fetchOptionalDetailSnapshotLane(label, DETAIL_URL, StablecoinDetailResponseSchema);
}

function fetchHistory(label = "history") {
  return fetchOptionalDetailSnapshotLane(label, HISTORY_URL, SupplyHistoryResponseSchema);
}

function snapshotFor(snapshots: ReturnType<typeof buildSnapshots>, id = USDT) {
  return snapshots.find((snapshot) => snapshot.stablecoinId === id)!;
}

function oversizedHistory() {
  return Array.from({ length: 500 }, (_, index) => ({
    date: 1_600_000_000 + index * 86_400, circulatingUsd: 100_000_000 + index, price: 1,
  }));
}

function coinRequest(raw: string) {
  const url = new URL(raw);
  const history = url.pathname.endsWith("/supply-history");
  const id = history ? url.searchParams.get("stablecoin")! : url.pathname.split("/").at(-1)!;
  return { url, history, id };
}

function bulkResponse(url: URL, entry: (id: string) => DetailSnapshotInputEntry) {
  return Response.json({ version: 1, entries: url.searchParams.get("ids")!.split(",").map(entry) });
}

function entryFor(entries: { id: string }[], id: string) {
  return entries.find((entry) => entry.id === id);
}

function laneClocks(clock: number) {
  return { liveSummary: clock, supplyHistory: clock };
}

function bulkEntry(id: string, updatedAt: number, overrides: Partial<Extract<DetailSnapshotInputEntry, { status: "available" }>> = {}): DetailSnapshotInputEntry {
  return {
    id, status: "available", liveSummary: liveSummary(), supplyHistory: [],
    updatedAt: laneClocks(updatedAt),
    freshness: { liveSummary: { status: "stale", maxAgeSec: 300 }, supplyHistory: { status: "fresh", maxAgeSec: 86_400 } },
    sources: { detailCacheUpdatedAt: updatedAt / 1000, publicationUpdatedAt: updatedAt / 1000,
      supplySnapshotUpdatedAt: updatedAt / 1000, supplySnapshotDate: updatedAt / 1000 },
    ...overrides,
  };
}

function silence(method: "warn" | "log" = "warn") {
  return vi.spyOn(console, method).mockImplementation(() => undefined);
}

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
      expect(snapshots.every((snapshot) => snapshot.generatedAt === 0 && Object.keys(snapshot.lanes).length === 0)).toBe(true);
      writeSnapshots(snapshots, outputDir);
      expect(checkSnapshots(outputDir)).toEqual(snapshots);
      const firstPath = join(outputDir, `${COINS[0].id}.json`);
      const firstBytes = readFileSync(firstPath);
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
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("carries body and header source clocks through snapshots rather than the build clock", async () => {
    credentials();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ price: 1, _meta: { updatedAt: 1_700_000_000 } }))
      .mockResolvedValueOnce(Response.json([], {
        headers: { Date: "Tue, 14 Nov 2023 22:13:20 GMT", "X-Data-Age": "3600", Age: "600" },
      })));
    const detail = await fetchDetail();
    const history = await fetchHistory();
    const snapshot = buildSnapshot({
      summary: projectStablecoinLiveSummary(detail!.data),
      history: history!.data,
      updatedAt: { liveSummary: detail!.updatedAt, supplyHistory: history!.updatedAt },
      generatedAt: 1_700_100_000_000,
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
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([], { headers: {
      "X-Data-Updated-At": sourceClock, Date: new Date(1_700_000_000_000).toUTCString(), "X-Data-Age": "10", Age: "20",
    } })));
    await expect(fetchHistory()).resolves.toEqual({ data: [] });
  });

  it("projects only compact above-fold fields from the full response", () => {
    const detail = StablecoinDetailResponseSchema.parse({
      price: null,
      tokens: [{ date: 1_700_000_000, totalCirculatingUSD: { peggedUSD: 100 }, research: ["large"] }],
      research: ["not cached"],
      prose: "not cached",
    });
    const summary = projectStablecoinLiveSummary(detail);

    expect(summary.price).toBeNull();
    expect(summary.circulating).toEqual({ peggedUSD: 100 });
    expect(summary).not.toHaveProperty("tokens");
    expect(summary).not.toHaveProperty("research");
    expect(summary).not.toHaveProperty("prose");
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
      reason: "supply-chain-dropout" as const, status: "chains-unavailable" as const, partialCoverage: true as const,
      quarantinedSince: 1_699_000_000,
      chains: [{
        chainLabel: "HyperEVM", listCurrentUsd: 0, baselineUsd: 3, baselineObservedAt: 1_698_900_000,
        baselineSource: "state" as const, resolution: "unavailable" as const,
      }],
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
      version: 1,
      stablecoinId: USDT,
      generatedAt: 1_700_000_000_000,
      lanes: { liveSummary: { price: "not-a-number" } },
    })).toThrow();
  });

  it("fails closed on upstream errors while allowing an explicitly absent lane", async () => {
    credentials();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockImplementation(async () => new Response("upstream unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
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
    const history = Array.from({ length: 90 }, (_, index) => ({
      date: 1_700_000_000 + index * 86_400,
      circulatingUsd: 100_000_000 + index * 10_000,
      price: 1 + index / 1_000_000,
    }));
    const snapshot = buildSnapshot({
      summary: liveSummary(),
      history,
    });

    expect(snapshot.lanes.liveSummary).toBeDefined();
    expect(snapshot.lanes.supplyHistory).toHaveLength(90);
    expect(serializedSnapshotBytes(snapshot)).toBeLessThanOrEqual(8 * 1024);
  });

  it("permits an empty envelope when both lanes exceed the cap", () => {
    silence();
    const oversizedBuckets = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [`peggedUSD-${"x".repeat(30)}-${index}`, index]),
    );
    const snapshot = buildSnapshot({
      summary: liveSummary({ circulating: oversizedBuckets }),
      history: oversizedHistory(),
    });

    expect(snapshot.lanes).toEqual({});
    expect(serializedSnapshotBytes(snapshot)).toBeLessThanOrEqual(8 * 1024);
  });
  it("adds the dated release assessment lane only where it fits beside the live lanes", () => {
    silence();
    const summary = liveSummary();
    const readScoresLatestRow = (id: string) => (id === USDT || id === USDC ? SCORES_ROW : null);
    const snapshots = buildSnapshots({
      generatedAt: 1_700_000_100_000,
      updatedAtById: new Map([[USDT, { liveSummary: 1_700_000_000_000 }]]),
      liveSummariesById: new Map([[USDT, summary], [USDC, summary]]),
      supplyHistoryById: new Map([[USDC, oversizedHistory()]]),
      readScoresLatestRow,
    });
    const usdt = snapshotFor(snapshots);
    const { asOfMs: _asOfMs, ...lane } = SCORES_ROW;
    expect(usdt.lanes).toEqual({ liveSummary: summary, safetyAssessment: lane });
    // Dated by the dataset clock, never the artifact clock.
    expect(usdt.updatedAt).toEqual({ liveSummary: 1_700_000_000_000, safetyAssessment: SCORES_ROW.asOfMs });
    expect(validateSnapshot(usdt)).toBe(usdt);
    // Oversized history still yields to the cap; the release lane joins what remains.
    expect(snapshotFor(snapshots, USDC).lanes)
      .toEqual({ liveSummary: summary, safetyAssessment: lane });
    const unrated = snapshots.find((candidate) => readScoresLatestRow(candidate.stablecoinId) === null)!;
    expect(unrated.lanes).toEqual({});
    expect(unrated.updatedAt).toEqual({});
    expect(() => validateSnapshot({ ...usdt, updatedAt: { liveSummary: 1 } }))
      .toThrow(/safety assessment lane is invalid or undated/);
  });

  it("compacts full-precision history so the dated assessment lane fits beside both live lanes", () => {
    const summary = liveSummary({ price: 0.007707534702047374, circulating: { peggedKES: 67_799.09458142496 } });
    const history = Array.from({ length: 90 }, (_, index) => ({
      date: 1_785_196_800 + index * 86_400,
      circulatingUsd: 163_174.16968380168 + index / 7,
      price: index === 0 ? null : 0.007662620215566711 + index / 3e9,
    }));
    history[1] = { ...history[1], circulatingUsd: 1e-9 };
    const updatedAt = laneClocks(1_700_000_000_000);
    const { asOfMs, ...assessment } = SCORES_ROW;
    // Full-precision bytes, to prove compaction shrinks the envelope below.
    const fullPrecisionBytes = serializedSnapshotBytes({
      version: 1, stablecoinId: USDT, generatedAt: 1_700_000_100_000,
      updatedAt: { ...updatedAt, safetyAssessment: asOfMs },
      lanes: { liveSummary: summary, supplyHistory: history, safetyAssessment: assessment },
    });
    const warning = silence();

    const snapshot = buildSnapshot({
      summary,
      history,
      updatedAt,
      generatedAt: 1_700_000_100_000,
      readScoresLatestRow: (id) => (id === USDT ? SCORES_ROW : null),
    });

    expect(warning).not.toHaveBeenCalled();
    expect(Object.keys(snapshot.lanes).sort()).toEqual(["liveSummary", "safetyAssessment", "supplyHistory"]);
    expect(serializedSnapshotBytes(snapshot)).toBeLessThanOrEqual(DETAIL_SNAPSHOT_TARGET_BYTES);
    expect(serializedSnapshotBytes(snapshot)).toBeLessThan(fullPrecisionBytes);
    const compacted = snapshot.lanes.supplyHistory!;
    expect(compacted).toHaveLength(90);
    // Unavailable stays unavailable, a tiny observed value never becomes zero,
    // and every value stays within 10 significant digits of the source.
    expect(compacted[0].price).toBeNull();
    expect(compacted[1].circulatingUsd).toBe(1e-9);
    expect(compacted[2].circulatingUsd).toBe(Number(history[2].circulatingUsd.toPrecision(10)));
    for (const [index, point] of compacted.entries()) {
      expect(point.date).toBe(history[index].date);
      expect(Math.abs(point.circulatingUsd - history[index].circulatingUsd))
        .toBeLessThanOrEqual(Math.abs(history[index].circulatingUsd) * 1e-9);
      if (point.price !== null) {
        expect(Math.abs(point.price - history[index].price!)).toBeLessThanOrEqual(history[index].price! * 1e-9);
      }
    }
  });

  it("retains a small summary when oversized history is removed", () => {
    silence();
    const summary = liveSummary();
    const snapshot = buildSnapshot({
      summary,
      history: oversizedHistory(),
    });
    expect(snapshot.lanes).toEqual({ liveSummary: summary });
    expect(serializedSnapshotBytes(snapshot)).toBeLessThanOrEqual(8 * 1024);
  });

  it("requires complete valid legacy age evidence without inventing receipt-time clocks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    credentials();
    const date = new Date(100_000).toUTCString();
    const cases: [Record<string, string>, number | null][] = [
      [{ "X-Data-Age": "10", Age: "20" }, null],
      [{ Date: "invalid", "X-Data-Age": "10", Age: "20" }, null],
      [{}, null],
      [{ Date: date }, null],
      [{ Date: date, "X-Data-Age": "10" }, null],
      [{ Date: date, Age: "20" }, null],
      [{ Date: date, "X-Data-Age": "invalid", Age: "invalid" }, null],
      ...["", "-1", "Infinity", "0x10", "1e2"].flatMap((invalid): [Record<string, string>, null][] => [
        [{ Date: date, "X-Data-Age": invalid, Age: "20" }, null],
        [{ Date: date, "X-Data-Age": "10", Age: invalid }, null],
      ]),
      [{ Date: date, "X-Data-Age": "10", Age: "20" }, 70_000],
      [{ Date: new Date(120_000).toUTCString(), "X-Data-Age": "10", Age: "40" }, 70_000],
      [{ Date: date, "X-Data-Age": "90", Age: "20" }, 0],
      [{ Date: date, "X-Data-Age": "0", Age: "0" }, 100_000],
    ];
    for (const [headers, expected] of cases) {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json([], { headers })));
      expect(await fetchHistory()).toEqual({ data: [], ...(expected !== null ? { updatedAt: expected } : {}) });
    }
  });

  it("rejects missing credentials before transport and malformed successful JSON", async () => {
    for (const name of ["PHAROS_API_KEY", "SITE_API_SHARED_SECRET", "DIGEST_API_KEY", "PUBLIC_DATASETS_API_KEY", "SMOKE_API_KEY"]) {
      vi.stubEnv(name, "");
    }
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
    vi.stubGlobal("fetch", vi.fn(async (raw: string) => {
      const { history, id } = coinRequest(raw);
      requested.add(id);
      return Response.json(history ? [] : { price: 1 });
    }));
    const snapshots = await generateSnapshots(false);
    const nonLive = COINS.filter((coin) => coin.status != null && coin.status !== "active" && coin.status !== "frozen");
    expect(nonLive.length).toBeGreaterThan(0);
    for (const coin of nonLive) {
      expect(requested.has(coin.id)).toBe(false);
      expect(snapshotFor(snapshots, coin.id)?.lanes).toEqual({});
    }
    expect(requested.has(USDT)).toBe(true);
    expect(snapshotFor(snapshots)?.lanes)
      .toMatchObject({ liveSummary: { price: 1 }, supplyHistory: [] });
    expect(snapshots.map((snapshot) => snapshot.stablecoinId)).toEqual(COINS.map((coin) => coin.id));
  });

  it("publishes healthy and unproven lanes without using the artifact clock as source provenance", async () => {
    credentials();
    clearApiUrls();
    vi.stubGlobal("fetch", vi.fn(async (raw: string) => {
      const { history, id } = coinRequest(raw);
      return Response.json(history ? [] : { price: 1 }, {
        headers: id === USDT && !history ? {} : { "X-Data-Updated-At": "1700000000" },
      });
    }));
    const snapshots = await generateSnapshots(false, { source: "per-coin", generatedAt: 1_700_000_100_000 });
    const unproven = snapshotFor(snapshots);
    expect(unproven.lanes).toMatchObject({ liveSummary: { price: 1 }, supplyHistory: [] });
    expect(unproven.updatedAt).toEqual({ supplyHistory: 1_700_000_000_000 });
    expect(snapshotFor(snapshots, USDC)?.updatedAt)
      .toEqual(laneClocks(1_700_000_000_000));
    expect(reportAges([unproven], unproven.generatedAt))
      .toContain("unavailable clocks=1; no summary lane=0");
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
      currentSupplyObservedAt: sourceClock, currentCirculatingUSD: { peggedUSD: 200 }, tokens: [[33, 50], [30, 80], [10, 100], [7, 140], [3, 160]].map(([days, supply]) => ({
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
    let pendingBulkBodies = 0;
    let peakBulkBodies = 0;
    let completedBatches = 0;
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
          return id === unavailableId
            ? { id, status: "unavailable", reason: "detail-cache-missing", sources }
            : bulkEntry(id, sourceClock * 1000, {
              liveSummary: projectStablecoinLiveSummary(StablecoinDetailResponseSchema.parse(detail)), supplyHistory: history,
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
      if (batches.length) expect(completedBatches).toBe(expectedBatches);
      perCoinIds.push(id);
      return Response.json(isHistory ? history : detail, { headers });
    }));
    const baseline = await generateSnapshots(false, { generatedAt: now });
    perCoinIds.length = 0;
    vi.stubEnv("PHAROS_DETAIL_SNAPSHOT_SOURCE", "bulk");
    const bulk = await generateSnapshots(false, { generatedAt: now });
    expect(bulk.map((snapshot) => `${JSON.stringify(snapshot)}\n`))
      .toEqual(baseline.map((snapshot) => `${JSON.stringify(snapshot)}\n`));
    const acquisition = JSON.parse(log.mock.calls[1][0] as string).detailSnapshotAcquisition;
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
    expect(perCoinIds).toEqual([unavailableId, unavailableId]);
    expect(peakBulkBodies).toBe(6);
    expect(pendingBulkBodies).toBe(0);
    expect(batches.every((ids) => ids.length <= BATCH_SIZE)).toBe(true);
    expect(batches.flat()).toEqual(LIVE_IDS);
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

  it("reads only the history lane for an inactive record whose bulk row proves the detail cache absent", async () => {
    credentials("fixture-key", "fixture-site-secret");
    clearApiUrls();
    const log = silence("log");
    silence();
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const frozenId = COINS.find((coin) => coin.status === "frozen")!.id;
    const activeId = COINS.find((coin) => coin.status == null || coin.status === "active")!.id;
    const sources = EMPTY_SOURCES;
    const perCoin: string[] = [];
    let historyAvailable = true;
    vi.stubGlobal("fetch", vi.fn(async (raw: string) => {
      const { url, history, id } = coinRequest(raw);
      if (url.pathname.endsWith("/stablecoin-detail-snapshot-inputs")) {
        return bulkResponse(url, (id) => id === frozenId || id === activeId
          ? { id, status: "unavailable", reason: "detail-cache-missing", sources }
          : bulkEntry(id, now - 60_000));
      }
      perCoin.push(`${history ? "history" : "detail"}:${id}`);
      if (!historyAvailable) return new Response("", { status: 404 });
      return Response.json(history ? [] : { price: 1 }, { headers: { "X-Data-Updated-At": "1799999900" } });
    }));
    const snapshots = await generateSnapshots(false, { source: "bulk", generatedAt: now });
    // The API answers an inactive record with no cached detail from that same absent
    // row, so the reviewed fallback must not spend a detail read on it.
    expect(perCoin).not.toContain(`detail:${frozenId}`);
    expect(perCoin).toContain(`history:${frozenId}`);
    expect(perCoin).toContain(`detail:${activeId}`);
    const frozen = snapshotFor(snapshots, frozenId);
    expect(frozen.lanes).toEqual({ supplyHistory: [] });
    expect(frozen.updatedAt).toEqual({ supplyHistory: 1_799_999_900_000 });
    const evidence = JSON.parse(log.mock.calls[0][0] as string).detailSnapshotAcquisition;
    expect(entryFor(evidence.entries, frozenId)).toMatchObject({
      source: "bulk-unavailable-history-only", reason: "detail-cache-missing", updatedAt: { supplyHistory: 1_799_999_900_000 },
    });
    expect(entryFor(evidence.entries, activeId))
      .toMatchObject({ source: "bulk-unavailable-fallback" });
    // History is still mandatory for every acquired coin.
    historyAvailable = false;
    await expect(generateSnapshots(false, { source: "bulk", generatedAt: now }))
      .rejects.toThrow(/No detail snapshot lanes were available/);
  });

});

describe("bounded stale bulk refresh", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("selects only producer ages strictly above the UI stale band, oldest first with a deterministic cap", () => {
    const now = 1_800_000_000_000;
    const boundary = now - UI_STALE_MS;
    const entries: DetailSnapshotInputEntry[] = [
      bulkEntry("fresh", now - 600_001),
      bulkEntry("at-boundary", boundary),
      bulkEntry("old-b", boundary - 1),
      bulkEntry("oldest", boundary - 1000),
      bulkEntry("old-a", boundary - 1),
      { id: "unavailable", status: "unavailable", reason: "detail-cache-missing",
        sources: EMPTY_SOURCES },
    ];
    expect(UI_STALE_MS).toBe(120 * 60_000);
    expect(selectRefreshIds(entries, now, 2)).toEqual(["oldest", "old-a"]);
    expect(selectRefreshIds(entries, now, 0)).toEqual([]);
    expect(selectRefreshIds(Array.from({ length: 30 }, (_, index) =>
      bulkEntry(`coin-${index}`, boundary - 1)), now)).toHaveLength(DETAIL_SNAPSHOT_STALE_REFRESH_LIMIT);
    for (const cap of [-1, 1.5, DETAIL_SNAPSHOT_STALE_REFRESH_LIMIT + 1]) {
      expect(() => selectRefreshIds(entries, now, cap)).toThrow(/refresh limit/);
    }
  });

  it("refreshes the selected rows after bulk bodies finish and records actual paths and clocks without re-stamping old rows", async () => {
    credentials("", "fixture-site-secret");
    clearApiUrls();
    const log = silence("log");
    silence();
    const now = 1_800_000_000_000;
    const liveIds = LIVE_IDS;
    const [refreshedId, retainedId, cappedId] = liveIds;
    const sourceClocks: Record<string, number> = {
      [refreshedId]: now - UI_STALE_MS - 3000,
      [retainedId]: now - UI_STALE_MS - 2000,
      [cappedId]: now - UI_STALE_MS - 1000,
    };
    const perCoinIds: string[] = [];
    let pendingBodies = 0;
    let peakBodies = 0;
    let bulkCompleted = 0;
    let failRefresh = false;
    const expectedBatches = Math.ceil(liveIds.length / BATCH_SIZE);
    vi.stubGlobal("fetch", vi.fn(async (raw: string, init: RequestInit) => {
      const { url, history, id } = coinRequest(raw);
      expect(url.hostname).toBe("site-api.pharos.watch");
      expect(new Headers(init.headers).get("X-Pharos-Site-Proxy-Secret")).toBe("fixture-site-secret");
      const bulk = url.pathname.endsWith("/stablecoin-detail-snapshot-inputs");
      pendingBodies++;
      peakBodies = Math.max(peakBodies, pendingBodies);
      expect(pendingBodies).toBeLessThanOrEqual(6);
      let response: Response;
      if (bulk) {
        response = bulkResponse(url, (id) => bulkEntry(id, sourceClocks[id] ?? now - 60_000));
      } else {
        expect(bulkCompleted % expectedBatches).toBe(0);
        perCoinIds.push(id);
        const clock = id === refreshedId ? now - 30_000 : sourceClocks[id];
        response = Response.json(history ? [] : { price: failRefresh ? "invalid" : 2 }, {
          headers: { "X-Data-Updated-At": String(clock / 1000) },
        });
      }
      const consume = response.json.bind(response);
      vi.spyOn(response, "json").mockImplementation(async () => {
        await Promise.resolve();
        const data = await consume();
        pendingBodies--;
        if (bulk) bulkCompleted++;
        return data;
      });
      return response;
    }));
    const snapshots = await generateSnapshots(false, { source: "bulk", generatedAt: now, staleRefreshLimit: 2 });
    const snapshot = (id: string) => snapshotFor(snapshots, id);
    expect(snapshot(refreshedId).updatedAt.liveSummary).toBe(now - 30_000);
    expect(snapshot(refreshedId).lanes.liveSummary?.price).toBe(2);
    expect(snapshot(retainedId).updatedAt.liveSummary).toBe(sourceClocks[retainedId]);
    expect(snapshot(cappedId).updatedAt.liveSummary).toBe(sourceClocks[cappedId]);
    expect(snapshot(cappedId).lanes.liveSummary?.price).toBe(1);
    expect(perCoinIds.sort()).toEqual([refreshedId, refreshedId, retainedId, retainedId].sort());
    expect(pendingBodies).toBe(0);
    expect(peakBodies).toBe(6);
    const evidence = JSON.parse(log.mock.calls[0][0] as string).detailSnapshotAcquisition;
    expect(evidence).toMatchObject({
      assessedAt: now, staleCandidateCount: 3, staleRefreshLimit: 2, staleRefreshBudgetMs: UI_STALE_MS,
    });
    expect(entryFor(evidence.entries, refreshedId)).toMatchObject({
      source: "bulk-stale-refresh", bulkUpdatedAt: { liveSummary: sourceClocks[refreshedId] },
      updatedAt: { liveSummary: now - 30_000 }, bulkSources: { detailCacheUpdatedAt: sourceClocks[refreshedId] / 1000 },
    });
    expect(entryFor(evidence.entries, retainedId)).toMatchObject({
      source: "bulk-stale-refresh", updatedAt: { liveSummary: sourceClocks[retainedId] },
    });
    expect(entryFor(evidence.entries, cappedId)).toMatchObject({
      source: "bulk-cache-only", updatedAt: { liveSummary: sourceClocks[cappedId] },
    });
    expect(snapshot(refreshedId)).not.toHaveProperty("acquisition");
    failRefresh = true;
    await expect(generateSnapshots(false, { source: "bulk", generatedAt: now, staleRefreshLimit: 2 })).rejects.toThrow();
  });

  it("spends the stale-refresh cap on refreshable records, never on a non-active row", async () => {
    credentials("", "fixture-site-secret");
    clearApiUrls();
    const log = silence("log");
    silence();
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    // Oldest first: the frozen row would take a cap slot if it stayed a candidate.
    const frozenId = COINS.find((coin) => coin.status === "frozen")!.id;
    const activeIds = COINS
      .filter((coin) => coin.status == null || coin.status === "active").slice(0, 3).map((coin) => coin.id);
    const staleClocks = new Map<string, number>([
      [frozenId, now - UI_STALE_MS - 4000],
      ...activeIds.map((id, index) => [id, now - UI_STALE_MS - 3000 + index * 1000] as const),
    ]);
    const perCoin: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (raw: string) => {
      const { url, history, id } = coinRequest(raw);
      if (url.pathname.endsWith("/stablecoin-detail-snapshot-inputs")) {
        return bulkResponse(url, (id) => bulkEntry(id, staleClocks.get(id) ?? now - 60_000));
      }
      perCoin.push(`${history ? "history" : "detail"}:${id}`);
      return Response.json(history ? [] : { price: 2 }, { headers: { "X-Data-Updated-At": String((now - 30_000) / 1000) } });
    }));
    const snapshots = await generateSnapshots(false, { source: "bulk", generatedAt: now, staleRefreshLimit: 2 });
    const snapshot = (id: string) => snapshotFor(snapshots, id);
    // The two oldest refreshable rows consume the cap; the frozen row keeps its bulk generation.
    expect(perCoin.sort()).toEqual([...activeIds.slice(0, 2).flatMap((id) => [`detail:${id}`, `history:${id}`])].sort());
    expect(snapshot(frozenId).updatedAt.liveSummary).toBe(staleClocks.get(frozenId));
    expect(snapshot(frozenId).lanes.liveSummary?.price).toBe(1);
    for (const id of activeIds.slice(0, 2)) {
      expect(snapshot(id).updatedAt.liveSummary).toBe(now - 30_000);
      expect(snapshot(id).lanes.liveSummary?.price).toBe(2);
    }
    expect(snapshot(activeIds[2]).updatedAt.liveSummary).toBe(staleClocks.get(activeIds[2]));
    const evidence = JSON.parse(log.mock.calls[0][0] as string).detailSnapshotAcquisition;
    expect(evidence).toMatchObject({ staleCandidateCount: 4, staleRefreshLimit: 2 });
    expect(entryFor(evidence.entries, frozenId)).toMatchObject({
      source: "bulk-cache-only", updatedAt: { liveSummary: staleClocks.get(frozenId) },
    });
    expect(entryFor(evidence.entries, activeIds[2]))
      .toMatchObject({ source: "bulk-cache-only" });
    expect(entryFor(evidence.entries, activeIds[1]))
      .toMatchObject({ source: "bulk-stale-refresh" });
  });

  it("reports producer-age percentiles and the UI budget without substituting artifact time or unavailable clocks", () => {
    const now = 1_800_000_000_000;
    const snapshots = buildSnapshots({
      generatedAt: now,
      liveSummariesById: new Map(COINS.slice(0, 4).map((coin) => [coin.id, liveSummary()])),
      updatedAtById: new Map(COINS.slice(0, 3).map((coin, index) =>
        [coin.id, { liveSummary: now - [60_000, UI_STALE_MS, UI_STALE_MS + 60_000][index] }])),
    });
    expect(reportAges(snapshots, now)).toContain("max=121.0 min, p50=120.0 min, p95=121.0 min");
    expect(reportAges(snapshots, now)).toContain("above UI stale budget 120 min: 1/3; unavailable clocks=1");
    expect(reportAges(snapshots, now)).toContain(`oldestProducerAt=${new Date(now - UI_STALE_MS - 60_000).toISOString()}`);
    expect(reportAges([], now)).toContain("max=unavailable, p50=unavailable, p95=unavailable");
    for (const clock of [0, -1, Number.NaN, now + 1]) {
      const unavailableClockSnapshot = {
        version: 1 as const, stablecoinId: USDT, generatedAt: now,
        lanes: { liveSummary: liveSummary() }, updatedAt: { liveSummary: clock },
      };
      expect(reportAges([unavailableClockSnapshot], now)).toContain("max=unavailable");
      expect(reportAges([unavailableClockSnapshot], now)).toContain("unavailable clocks=1");
    }
  });
});
