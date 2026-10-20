import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { StablecoinDetailResponseSchema, SupplyHistoryResponseSchema } from "@shared/types/market";
import { projectStablecoinLiveSummary } from "@shared/lib/stablecoin-live-summary";
import type { StablecoinLiveSummary } from "@shared/types/stablecoin-live-summary";
import { DETAIL_SNAPSHOT_INPUT_BATCH_SIZE, type DetailSnapshotInputEntry } from "@shared/types/detail-snapshot-inputs";
import {
  buildStablecoinDetailSnapshots,
  checkSnapshots,
  DETAIL_SNAPSHOT_STALE_REFRESH_LIMIT,
  DETAIL_SNAPSHOT_UI_STALE_AFTER_MS,
  fetchOptionalDetailSnapshotLane,
  generateSnapshots,
  reportSnapshotProducerAges,
  selectStaleDetailSnapshotRefreshIds,
  serializedSnapshotBytes,
  validateStablecoinDetailSnapshot,
  writeSnapshots,
} from "../build-stablecoin-detail-snapshots";

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

function bulkEntry(id: string, updatedAt: number): DetailSnapshotInputEntry {
  return {
    id, status: "available", liveSummary: liveSummary(), supplyHistory: [],
    updatedAt: { liveSummary: updatedAt, supplyHistory: updatedAt },
    freshness: { liveSummary: { status: "stale", maxAgeSec: 300 }, supplyHistory: { status: "fresh", maxAgeSec: 86_400 } },
    sources: { detailCacheUpdatedAt: updatedAt / 1000, publicationUpdatedAt: updatedAt / 1000,
      supplySnapshotUpdatedAt: updatedAt / 1000, supplySnapshotDate: updatedAt / 1000 },
  };
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
      expect(snapshots).toHaveLength(TRACKED_STABLECOINS.length);
      expect(snapshots.every((snapshot) => snapshot.generatedAt === 0 && Object.keys(snapshot.lanes).length === 0)).toBe(true);
      writeSnapshots(snapshots, outputDir);
      expect(checkSnapshots(outputDir)).toEqual(snapshots);
      const firstPath = join(outputDir, `${TRACKED_STABLECOINS[0].id}.json`);
      const firstBytes = readFileSync(firstPath);
      rmSync(firstPath);
      expect(() => checkSnapshots(outputDir)).toThrow(/Missing stablecoin detail snapshot/);
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
    vi.stubEnv("PHAROS_API_KEY", "fixture-key");
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ price: 1, _meta: { updatedAt: 1_700_000_000 } }))
      .mockResolvedValueOnce(Response.json([], {
        headers: { Date: "Tue, 14 Nov 2023 22:13:20 GMT", "X-Data-Age": "3600", Age: "600" },
      })));
    const detail = await fetchOptionalDetailSnapshotLane("detail", "https://api.pharos.watch/api/stablecoin/usdt-tether", StablecoinDetailResponseSchema);
    const history = await fetchOptionalDetailSnapshotLane("history", "https://api.pharos.watch/api/supply-history", SupplyHistoryResponseSchema);
    const snapshot = buildStablecoinDetailSnapshots({
      generatedAt: 1_700_100_000_000,
      liveSummariesById: new Map([["usdt-tether", projectStablecoinLiveSummary(detail!.data)]]),
      supplyHistoryById: new Map([["usdt-tether", history!.data]]),
      updatedAtById: new Map([["usdt-tether", { liveSummary: detail!.updatedAt, supplyHistory: history!.updatedAt }]]),
    }).find((candidate) => candidate.stablecoinId === "usdt-tether")!;
    expect(snapshot.updatedAt).toEqual({ liveSummary: 1_700_000_000_000, supplyHistory: 1_699_995_800_000 });
  });

  it("prefers origin clocks over rewritten Date/ages and preserves body provenance first", async () => {
    vi.stubEnv("PHAROS_API_KEY", "fixture-key");
    const headers = { "X-Data-Updated-At": "1700000000.125", Date: new Date(1_800_000_000_000).toUTCString(), Age: "500", "X-Data-Age": "100" };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json([], { headers }))
      .mockResolvedValueOnce(Response.json({ price: 1, _meta: { updatedAt: 1_600_000_000 } }, { headers })));
    expect(await fetchOptionalDetailSnapshotLane(
      "history", "https://api.pharos.watch/api/supply-history", SupplyHistoryResponseSchema,
    )).toEqual({ data: [], updatedAt: 1_700_000_000_125 });
    expect((await fetchOptionalDetailSnapshotLane(
      "detail", "https://api.pharos.watch/api/stablecoin/usdt-tether", StablecoinDetailResponseSchema,
    ))?.updatedAt).toBe(1_600_000_000_000);
  });

  it.each(["", "invalid", "-1", "Infinity", "1e309", "0x10", ".5", "5.", "1..2", "1 2"])("retains payload without a malformed origin clock (%s) or legacy fallback", async (sourceClock) => {
    vi.stubEnv("PHAROS_API_KEY", "fixture-key");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([], { headers: {
      "X-Data-Updated-At": sourceClock, Date: new Date(1_700_000_000_000).toUTCString(), "X-Data-Age": "10", Age: "20",
    } })));
    await expect(fetchOptionalDetailSnapshotLane(
      "history", "https://api.pharos.watch/api/supply-history", SupplyHistoryResponseSchema,
    )).resolves.toEqual({ data: [] });
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
    const snapshots = buildStablecoinDetailSnapshots({
      generatedAt: 1_700_000_000_000,
      updatedAtById: new Map(),
      liveSummariesById: new Map([["usdt-tether", summary]]),
      supplyHistoryById: new Map([[
        "usdt-tether",
        [{ date: 1_700_000_000, circulatingUsd: 100, price: 1 }],
      ]]),
    });
    const snapshot = snapshots.find((candidate) => candidate.stablecoinId === "usdt-tether")!;

    expect(validateStablecoinDetailSnapshot(snapshot)).toEqual(snapshot);
    expect(snapshot.lanes.liveSummary).toEqual(summary);
    expect(snapshot.lanes.supplyHistory).toHaveLength(1);
  });

  it("rejects a generated compact lane that no longer matches its runtime schema", () => {
    expect(() => validateStablecoinDetailSnapshot({
      version: 1,
      stablecoinId: "usdt-tether",
      generatedAt: 1_700_000_000_000,
      lanes: { liveSummary: { price: "not-a-number" } },
    })).toThrow();
  });

  it("fails closed on upstream errors while allowing an explicitly absent lane", async () => {
    vi.stubEnv("PHAROS_API_KEY", "fixture-key");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockImplementation(async () => new Response("upstream unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(fetchOptionalDetailSnapshotLane(
      "optional history",
      "https://api.pharos.watch/api/supply-history",
      SupplyHistoryResponseSchema,
    )).resolves.toBeNull();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("HTTP 404"));
    vi.useFakeTimers();
    const failure = expect(fetchOptionalDetailSnapshotLane(
      "coin detail for usdt-tether",
      "https://api.pharos.watch/api/stablecoin/usdt-tether",
      StablecoinDetailResponseSchema,
    )).rejects.toThrow("HTTP 503");
    await vi.runAllTimersAsync();
    await failure;
  });


  it("fails closed when a successful response does not match its lane schema", async () => {
    vi.stubEnv("PHAROS_API_KEY", "fixture-key");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ price: "invalid", tokens: [] })));
    await expect(fetchOptionalDetailSnapshotLane(
      "coin detail for usdt-tether",
      "https://api.pharos.watch/api/stablecoin/usdt-tether",
      StablecoinDetailResponseSchema,
    )).rejects.toThrow();
  });

  it("keeps a representative compact summary and 90-day supply envelope within 8 KiB", () => {
    const history = Array.from({ length: 90 }, (_, index) => ({
      date: 1_700_000_000 + index * 86_400,
      circulatingUsd: 100_000_000 + index * 10_000,
      price: 1 + index / 1_000_000,
    }));
    const snapshot = buildStablecoinDetailSnapshots({
      generatedAt: 1_700_000_000_000,
      updatedAtById: new Map(),
      liveSummariesById: new Map([["usdt-tether", liveSummary()]]),
      supplyHistoryById: new Map([["usdt-tether", history]]),
    }).find((candidate) => candidate.stablecoinId === "usdt-tether")!;

    expect(snapshot.lanes.liveSummary).toBeDefined();
    expect(snapshot.lanes.supplyHistory).toHaveLength(90);
    expect(serializedSnapshotBytes(snapshot)).toBeLessThanOrEqual(8 * 1024);
  });

  it("permits an empty envelope when both lanes exceed the cap", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const oversizedBuckets = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [`peggedUSD-${"x".repeat(30)}-${index}`, index]),
    );
    const snapshot = buildStablecoinDetailSnapshots({
      generatedAt: 1_700_000_000_000,
      updatedAtById: new Map(),
      liveSummariesById: new Map([["usdt-tether", liveSummary({ circulating: oversizedBuckets })]]),
      supplyHistoryById: new Map([[
        "usdt-tether",
        Array.from({ length: 500 }, (_, index) => ({
          date: 1_600_000_000 + index * 86_400,
          circulatingUsd: 100_000_000 + index,
          price: 1,
        })),
      ]]),
    }).find((candidate) => candidate.stablecoinId === "usdt-tether")!;

    expect(snapshot.lanes).toEqual({});
    expect(serializedSnapshotBytes(snapshot)).toBeLessThanOrEqual(8 * 1024);
  });
  it("retains a small summary when oversized history is removed", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const summary = liveSummary();
    const snapshot = buildStablecoinDetailSnapshots({
      generatedAt: 1_700_000_000_000, updatedAtById: new Map(),
      liveSummariesById: new Map([["usdt-tether", summary]]),
      supplyHistoryById: new Map([["usdt-tether", Array.from({ length: 500 }, (_, index) => ({
        date: 1_600_000_000 + index * 86_400, circulatingUsd: 100_000_000 + index, price: 1,
      }))]]),
    }).find((candidate) => candidate.stablecoinId === "usdt-tether")!;
    expect(snapshot.lanes).toEqual({ liveSummary: summary });
    expect(serializedSnapshotBytes(snapshot)).toBeLessThanOrEqual(8 * 1024);
  });

  it("requires complete valid legacy age evidence without inventing receipt-time clocks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    vi.stubEnv("PHAROS_API_KEY", "fixture-key");
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
      expect(await fetchOptionalDetailSnapshotLane(
        "history", "https://api.pharos.watch/api/supply-history", SupplyHistoryResponseSchema,
      )).toEqual({ data: [], ...(expected !== null ? { updatedAt: expected } : {}) });
    }
  });

  it("rejects missing credentials before transport and malformed successful JSON", async () => {
    for (const name of ["PHAROS_API_KEY", "SITE_API_SHARED_SECRET", "DIGEST_API_KEY", "PUBLIC_DATASETS_API_KEY", "SMOKE_API_KEY"]) {
      vi.stubEnv(name, "");
    }
    const fetch = vi.fn(async () => new Response("malformed-json"));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchOptionalDetailSnapshotLane(
      "detail", "https://api.pharos.watch/api/stablecoin/usdt-tether", StablecoinDetailResponseSchema,
    )).rejects.toThrow(/required/);
    expect(fetch).not.toHaveBeenCalled();
    vi.stubEnv("PHAROS_API_KEY", "fixture-key");
    await expect(fetchOptionalDetailSnapshotLane(
      "detail", "https://api.pharos.watch/api/stablecoin/usdt-tether", StablecoinDetailResponseSchema,
    )).rejects.toBeInstanceOf(SyntaxError);
  });

  it("refuses to generate an empty envelope for a live stablecoin", async () => {
    vi.stubEnv("PHAROS_API_KEY", "fixture-key");
    for (const name of ["DIGEST_API_URL", "PUBLIC_DATASETS_API_URL", "SMOKE_API_BASE", "API_BASE_URL"]) vi.stubEnv(name, "");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(generateSnapshots(false)).rejects.toThrow(/No detail snapshot lanes were available/);
  });

  it("fetches live IDs but preserves empty envelopes for non-live catalog members", async () => {
    vi.stubEnv("PHAROS_API_KEY", "fixture-key");
    for (const name of ["DIGEST_API_URL", "PUBLIC_DATASETS_API_URL", "SMOKE_API_BASE", "API_BASE_URL"]) vi.stubEnv(name, "");
    const requested = new Set<string>();
    vi.stubGlobal("fetch", vi.fn(async (raw: string) => {
      const url = new URL(raw);
      const history = url.pathname.endsWith("/supply-history");
      requested.add(history ? url.searchParams.get("stablecoin")! : url.pathname.split("/").at(-1)!);
      return Response.json(history ? [] : { price: 1 });
    }));
    const snapshots = await generateSnapshots(false);
    const nonLive = TRACKED_STABLECOINS.filter((coin) => coin.status != null && coin.status !== "active" && coin.status !== "frozen");
    expect(nonLive.length).toBeGreaterThan(0);
    for (const coin of nonLive) {
      expect(requested.has(coin.id)).toBe(false);
      expect(snapshots.find((snapshot) => snapshot.stablecoinId === coin.id)?.lanes).toEqual({});
    }
    expect(requested.has("usdt-tether")).toBe(true);
    expect(snapshots.find((snapshot) => snapshot.stablecoinId === "usdt-tether")?.lanes)
      .toMatchObject({ liveSummary: { price: 1 }, supplyHistory: [] });
    expect(snapshots.map((snapshot) => snapshot.stablecoinId)).toEqual(TRACKED_STABLECOINS.map((coin) => coin.id));
  });

  it("publishes healthy and unproven lanes without using the artifact clock as source provenance", async () => {
    vi.stubEnv("PHAROS_API_KEY", "fixture-key");
    for (const name of ["DIGEST_API_URL", "PUBLIC_DATASETS_API_URL", "SMOKE_API_BASE", "API_BASE_URL"]) vi.stubEnv(name, "");
    vi.stubGlobal("fetch", vi.fn(async (raw: string) => {
      const url = new URL(raw);
      const history = url.pathname.endsWith("/supply-history");
      const id = history ? url.searchParams.get("stablecoin") : url.pathname.split("/").at(-1);
      return Response.json(history ? [] : { price: 1 }, {
        headers: id === "usdt-tether" && !history ? {} : { "X-Data-Updated-At": "1700000000" },
      });
    }));
    const snapshots = await generateSnapshots(false, { source: "per-coin", generatedAt: 1_700_000_100_000 });
    const unproven = snapshots.find((snapshot) => snapshot.stablecoinId === "usdt-tether")!;
    expect(unproven.lanes).toMatchObject({ liveSummary: { price: 1 }, supplyHistory: [] });
    expect(unproven.updatedAt).toEqual({ supplyHistory: 1_700_000_000_000 });
    expect(snapshots.find((snapshot) => snapshot.stablecoinId === "usdc-circle")?.updatedAt)
      .toEqual({ liveSummary: 1_700_000_000_000, supplyHistory: 1_700_000_000_000 });
    expect(reportSnapshotProducerAges([unproven], unproven.generatedAt))
      .toContain("unavailable clocks=1; no summary lane=0");
  });

  it.each([false, true])("produces identical bulk bytes and falls back only for unavailable coins (originClock=%s)", async (originClock) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubEnv("PHAROS_API_KEY", "fixture-key");
    vi.stubEnv("SITE_API_SHARED_SECRET", "fixture-site-secret");
    vi.stubEnv("PHAROS_DETAIL_SNAPSHOT_SOURCE", "per-coin");
    for (const name of ["DIGEST_API_URL", "PUBLIC_DATASETS_API_URL", "SMOKE_API_BASE", "API_BASE_URL"]) vi.stubEnv(name, "");
    const now = 1_800_000_000_000;
    const sourceClock = 1_799_999_900;
    const day = 86_400;
    const detail = { price: 1, priceSource: "coingecko",
      currentSupplyObservedAt: sourceClock, currentCirculatingUSD: { peggedUSD: 200 }, tokens: [
        { date: sourceClock - 33 * day, totalCirculatingUSD: { peggedUSD: 50 }, totalCirculating: { peggedUSD: 50 } },
        { date: sourceClock - 30 * day, totalCirculatingUSD: { peggedUSD: 80 }, totalCirculating: { peggedUSD: 80 } },
        { date: sourceClock - 10 * day, totalCirculatingUSD: { peggedUSD: 100 }, totalCirculating: { peggedUSD: 100 } },
        { date: sourceClock - 7 * day, totalCirculatingUSD: { peggedUSD: 140 }, totalCirculating: { peggedUSD: 140 } },
        { date: sourceClock - 3 * day, totalCirculatingUSD: { peggedUSD: 160 }, totalCirculating: { peggedUSD: 160 } },
      ] };
    const history = [{ date: sourceClock, circulatingUsd: 100, price: 1 }];
    // Origin provenance also survives the one-second loss in legacy Date/age arithmetic.
    const headers = new Headers({ Date: new Date((sourceClock + 1200 + Number(originClock)) * 1000).toUTCString(), Age: "1200", "X-Data-Age": "0" });
    if (originClock) headers.set("X-Data-Updated-At", String(sourceClock));
    const perCoinIds: string[] = [];
    const batches: string[][] = [];
    const unavailableId = "usdt-tether";
    let pendingBulkBodies = 0;
    let peakBulkBodies = 0;
    let completedBatches = 0;
    const expectedBatches = Math.ceil(TRACKED_STABLECOINS
      .filter((coin) => coin.status == null || coin.status === "active" || coin.status === "frozen").length / DETAIL_SNAPSHOT_INPUT_BATCH_SIZE);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async (raw: string) => {
      const url = new URL(raw);
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
            : { id, status: "available", liveSummary: projectStablecoinLiveSummary(StablecoinDetailResponseSchema.parse(detail)),
              supplyHistory: history, updatedAt: { liveSummary: sourceClock * 1000, supplyHistory: sourceClock * 1000 },
              freshness: { liveSummary: { status: "fresh", maxAgeSec: 300 }, supplyHistory: { status: "fresh", maxAgeSec: 86_400 } }, sources };
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
      const isHistory = url.pathname.endsWith("/supply-history");
      perCoinIds.push(isHistory ? url.searchParams.get("stablecoin")! : url.pathname.split("/").at(-1)!);
      return Response.json(isHistory ? history : detail, { headers });
    }));
    const baseline = await generateSnapshots(false, { generatedAt: now });
    perCoinIds.length = 0;
    vi.stubEnv("PHAROS_DETAIL_SNAPSHOT_SOURCE", "bulk");
    const bulk = await generateSnapshots(false, { generatedAt: now });
    expect(bulk.map((snapshot) => `${JSON.stringify(snapshot)}\n`))
      .toEqual(baseline.map((snapshot) => `${JSON.stringify(snapshot)}\n`));
    const acquisition = JSON.parse(log.mock.calls[1][0] as string).detailSnapshotAcquisition;
    expect(acquisition.entries.find((entry: { id: string }) => entry.id === unavailableId)).toMatchObject({
      source: "bulk-unavailable-fallback", reason: "detail-cache-missing",
      updatedAt: { liveSummary: sourceClock * 1000 }, bulkSources: { detailCacheUpdatedAt: sourceClock },
    });
    expect(acquisition.entries.find((entry: { id: string }) => entry.id === "usdc-circle")).toMatchObject({
      source: "bulk-cache-only", updatedAt: { liveSummary: sourceClock * 1000 },
    });
    for (const snapshots of [baseline, bulk]) {
      expect(snapshots.find((snapshot) => snapshot.stablecoinId === "usdc-circle")?.lanes.liveSummary).toMatchObject({
        circulatingPrevWeek: { peggedUSD: 140 }, circulatingPrevMonth: { peggedUSD: 80 },
        nativeSupply: { current: 200, prevWeek: 140, prevMonth: 80 },
      });
    }
    expect(perCoinIds).toEqual([unavailableId, unavailableId]);
    expect(peakBulkBodies).toBe(6);
    expect(pendingBulkBodies).toBe(0);
    expect(batches.every((ids) => ids.length <= DETAIL_SNAPSHOT_INPUT_BATCH_SIZE)).toBe(true);
    expect(batches.flat()).toEqual(TRACKED_STABLECOINS
      .filter((coin) => coin.status == null || coin.status === "active" || coin.status === "frozen").map((coin) => coin.id));
  });

  it("keeps credentialless bulk-configured Pages releases on per-coin acquisition", async () => {
    vi.stubEnv("PHAROS_API_KEY", "");
    vi.stubEnv("SITE_API_SHARED_SECRET", "");
    vi.spyOn(process, "loadEnvFile").mockImplementation(() => undefined);
    for (const name of ["DIGEST_API_URL", "PUBLIC_DATASETS_API_URL", "SMOKE_API_BASE", "API_BASE_URL"]) vi.stubEnv(name, "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetch = vi.fn(async (raw: string) => {
      const url = new URL(raw);
      expect(url.pathname).toMatch(/^\/_site-data\/(stablecoin\/|supply-history)/);
      return Response.json(url.pathname.endsWith("/supply-history") ? [] : { price: 1, tokens: [] });
    });
    vi.stubGlobal("fetch", fetch);
    const snapshots = await generateSnapshots(false, { source: "bulk" });
    expect(snapshots).toHaveLength(TRACKED_STABLECOINS.length);
    expect(fetch).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("using per-coin acquisition"));
  });

  it("rejects malformed or incomplete bulk accounting without silently falling back", async () => {
    vi.stubEnv("PHAROS_API_KEY", "fixture-key");
    vi.stubEnv("SITE_API_SHARED_SECRET", "fixture-site-secret");
    for (const name of ["DIGEST_API_URL", "PUBLIC_DATASETS_API_URL", "SMOKE_API_BASE", "API_BASE_URL"]) vi.stubEnv(name, "");
    const fetch = vi.fn(async () => Response.json({ version: 1, entries: [{
      id: "not-requested", status: "unavailable", reason: "detail-cache-missing",
      sources: { detailCacheUpdatedAt: null, publicationUpdatedAt: null, supplySnapshotUpdatedAt: null, supplySnapshotDate: null },
    }] }));
    vi.stubGlobal("fetch", fetch);
    await expect(generateSnapshots(false, { source: "bulk" })).rejects.toThrow(/account for every requested coin/);
    expect(fetch).toHaveBeenCalledTimes(6);
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
    const boundary = now - DETAIL_SNAPSHOT_UI_STALE_AFTER_MS;
    const entries: DetailSnapshotInputEntry[] = [
      bulkEntry("fresh", now - 600_001),
      bulkEntry("at-boundary", boundary),
      bulkEntry("old-b", boundary - 1),
      bulkEntry("oldest", boundary - 1000),
      bulkEntry("old-a", boundary - 1),
      { id: "unavailable", status: "unavailable", reason: "detail-cache-missing",
        sources: { detailCacheUpdatedAt: null, publicationUpdatedAt: null, supplySnapshotUpdatedAt: null, supplySnapshotDate: null } },
    ];
    expect(DETAIL_SNAPSHOT_UI_STALE_AFTER_MS).toBe(120 * 60_000);
    expect(selectStaleDetailSnapshotRefreshIds(entries, now, 2)).toEqual(["oldest", "old-a"]);
    expect(selectStaleDetailSnapshotRefreshIds(entries, now, 0)).toEqual([]);
    expect(selectStaleDetailSnapshotRefreshIds(Array.from({ length: 30 }, (_, index) =>
      bulkEntry(`coin-${index}`, boundary - 1)), now)).toHaveLength(DETAIL_SNAPSHOT_STALE_REFRESH_LIMIT);
    for (const cap of [-1, 1.5, DETAIL_SNAPSHOT_STALE_REFRESH_LIMIT + 1]) {
      expect(() => selectStaleDetailSnapshotRefreshIds(entries, now, cap)).toThrow(/refresh limit/);
    }
  });

  it("refreshes the selected rows after bulk bodies finish and records actual paths and clocks without re-stamping old rows", async () => {
    vi.stubEnv("PHAROS_API_KEY", "");
    vi.stubEnv("SITE_API_SHARED_SECRET", "fixture-site-secret");
    for (const name of ["DIGEST_API_URL", "PUBLIC_DATASETS_API_URL", "SMOKE_API_BASE", "API_BASE_URL"]) vi.stubEnv(name, "");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const now = 1_800_000_000_000;
    const liveIds = TRACKED_STABLECOINS
      .filter((coin) => coin.status == null || coin.status === "active" || coin.status === "frozen").map((coin) => coin.id);
    const [refreshedId, retainedId, cappedId] = liveIds;
    const sourceClocks: Record<string, number> = {
      [refreshedId]: now - DETAIL_SNAPSHOT_UI_STALE_AFTER_MS - 3000,
      [retainedId]: now - DETAIL_SNAPSHOT_UI_STALE_AFTER_MS - 2000,
      [cappedId]: now - DETAIL_SNAPSHOT_UI_STALE_AFTER_MS - 1000,
    };
    const perCoinIds: string[] = [];
    let pendingBodies = 0;
    let peakBodies = 0;
    let bulkCompleted = 0;
    let failRefresh = false;
    const expectedBatches = Math.ceil(liveIds.length / DETAIL_SNAPSHOT_INPUT_BATCH_SIZE);
    vi.stubGlobal("fetch", vi.fn(async (raw: string, init: RequestInit) => {
      const url = new URL(raw);
      expect(url.hostname).toBe("site-api.pharos.watch");
      expect(new Headers(init.headers).get("X-Pharos-Site-Proxy-Secret")).toBe("fixture-site-secret");
      const bulk = url.pathname.endsWith("/stablecoin-detail-snapshot-inputs");
      pendingBodies++;
      peakBodies = Math.max(peakBodies, pendingBodies);
      expect(pendingBodies).toBeLessThanOrEqual(6);
      let response: Response;
      if (bulk) {
        response = Response.json({ version: 1, entries: url.searchParams.get("ids")!.split(",")
          .map((id) => bulkEntry(id, sourceClocks[id] ?? now - 60_000)) });
      } else {
        expect(bulkCompleted % expectedBatches).toBe(0);
        const history = url.pathname.endsWith("/supply-history");
        const id = history ? url.searchParams.get("stablecoin")! : url.pathname.split("/").at(-1)!;
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
    const snapshot = (id: string) => snapshots.find((candidate) => candidate.stablecoinId === id)!;
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
      assessedAt: now, staleCandidateCount: 3, staleRefreshLimit: 2, staleRefreshBudgetMs: DETAIL_SNAPSHOT_UI_STALE_AFTER_MS,
    });
    expect(evidence.entries.find((entry: { id: string }) => entry.id === refreshedId)).toMatchObject({
      source: "bulk-stale-refresh", bulkUpdatedAt: { liveSummary: sourceClocks[refreshedId] },
      updatedAt: { liveSummary: now - 30_000 }, bulkSources: { detailCacheUpdatedAt: sourceClocks[refreshedId] / 1000 },
    });
    expect(evidence.entries.find((entry: { id: string }) => entry.id === retainedId)).toMatchObject({
      source: "bulk-stale-refresh", updatedAt: { liveSummary: sourceClocks[retainedId] },
    });
    expect(evidence.entries.find((entry: { id: string }) => entry.id === cappedId)).toMatchObject({
      source: "bulk-cache-only", updatedAt: { liveSummary: sourceClocks[cappedId] },
    });
    expect(snapshot(refreshedId)).not.toHaveProperty("acquisition");
    failRefresh = true;
    await expect(generateSnapshots(false, { source: "bulk", generatedAt: now, staleRefreshLimit: 2 })).rejects.toThrow();
  });

  it("reports producer-age percentiles and the UI budget without substituting artifact time or unavailable clocks", () => {
    const now = 1_800_000_000_000;
    const snapshots = buildStablecoinDetailSnapshots({
      generatedAt: now, liveSummariesById: new Map(TRACKED_STABLECOINS.slice(0, 4).map((coin) => [coin.id, liveSummary()])),
      supplyHistoryById: new Map(),
      updatedAtById: new Map(TRACKED_STABLECOINS.slice(0, 3).map((coin, index) =>
        [coin.id, { liveSummary: now - [60_000, DETAIL_SNAPSHOT_UI_STALE_AFTER_MS, DETAIL_SNAPSHOT_UI_STALE_AFTER_MS + 60_000][index] }])),
    });
    expect(reportSnapshotProducerAges(snapshots, now)).toContain("max=121.0 min, p50=120.0 min, p95=121.0 min");
    expect(reportSnapshotProducerAges(snapshots, now)).toContain("above UI stale budget 120 min: 1/3; unavailable clocks=1");
    expect(reportSnapshotProducerAges(snapshots, now)).toContain(`oldestProducerAt=${new Date(now - DETAIL_SNAPSHOT_UI_STALE_AFTER_MS - 60_000).toISOString()}`);
    expect(reportSnapshotProducerAges([], now)).toContain("max=unavailable, p50=unavailable, p95=unavailable");
    for (const clock of [0, -1, Number.NaN, now + 1]) {
      const unavailableClockSnapshot = {
        version: 1 as const, stablecoinId: "usdt-tether", generatedAt: now,
        lanes: { liveSummary: liveSummary() }, updatedAt: { liveSummary: clock },
      };
      expect(reportSnapshotProducerAges([unavailableClockSnapshot], now)).toContain("max=unavailable");
      expect(reportSnapshotProducerAges([unavailableClockSnapshot], now)).toContain("unavailable clocks=1");
    }
  });
});
