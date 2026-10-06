import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { StablecoinDetailResponseSchema, SupplyHistoryResponseSchema } from "@shared/types/market";
import { projectStablecoinLiveSummary } from "@shared/lib/stablecoin-live-summary";
import type { StablecoinLiveSummary } from "@shared/types/stablecoin-live-summary";
import { DETAIL_SNAPSHOT_INPUT_BATCH_SIZE } from "@shared/types/detail-snapshot-inputs";
import {
  buildStablecoinDetailSnapshots,
  checkSnapshots,
  fetchOptionalDetailSnapshotLane,
  generateSnapshots,
  resolveSnapshotApiBase,
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

  it.each(["", "invalid", "-1", "Infinity", "1e309", "0x10", ".5", "5.", "1..2", "1 2"])("rejects a malformed present origin clock (%s) without legacy fallback", async (sourceClock) => {
    vi.stubEnv("PHAROS_API_KEY", "fixture-key");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([], { headers: {
      "X-Data-Updated-At": sourceClock, Date: new Date(1_700_000_000_000).toUTCString(),
    } })));
    await expect(fetchOptionalDetailSnapshotLane(
      "history", "https://api.pharos.watch/api/supply-history", SupplyHistoryResponseSchema,
    )).rejects.toThrow(/Invalid X-Data-Updated-At/);
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

  it("reads the public site-data lane when no build credential is configured", () => {
    for (const name of ["PHAROS_API_KEY", "SITE_API_SHARED_SECRET", "DIGEST_API_KEY", "PUBLIC_DATASETS_API_KEY", "SMOKE_API_KEY",
      "DIGEST_API_URL", "PUBLIC_DATASETS_API_URL", "SMOKE_API_BASE", "API_BASE_URL"]) {
      vi.stubEnv(name, "");
    }
    expect(resolveSnapshotApiBase()).toBe("https://stablecoin-dashboard.pages.dev/_site-data");

    vi.stubEnv("PHAROS_API_KEY", "fixture-key");
    expect(resolveSnapshotApiBase()).toBe("https://api.pharos.watch");

    vi.stubEnv("PUBLIC_DATASETS_API_URL", "https://stablecoin-dashboard.pages.dev/_site-data");
    expect(resolveSnapshotApiBase()).toBe("https://stablecoin-dashboard.pages.dev/_site-data");
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

  it("normalizes fallback source clocks using both ages and clamps negative results", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    vi.stubEnv("PHAROS_API_KEY", "fixture-key");
    const cases: [Record<string, string>, number][] = [
      [{ "X-Data-Age": "10", Age: "20" }, 70_000],
      [{ Date: "invalid", "X-Data-Age": "10", Age: "20" }, 70_000],
      [{}, 100_000],
      [{ "X-Data-Age": "invalid", Age: "invalid" }, 100_000],
      [{ Date: new Date(100_000).toUTCString(), "X-Data-Age": "10", Age: "20" }, 70_000],
      [{ Date: new Date(120_000).toUTCString(), "X-Data-Age": "10", Age: "40" }, 70_000],
      [{ "X-Data-Age": "90", Age: "20" }, 0],
    ];
    for (const [headers, expected] of cases) {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json([], { headers })));
      expect(await fetchOptionalDetailSnapshotLane(
        "history", "https://api.pharos.watch/api/supply-history", SupplyHistoryResponseSchema,
      )).toEqual({ data: [], updatedAt: expected });
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

  it.each([false, true])("produces identical bulk bytes and falls back only for unavailable coins (originClock=%s)", async (originClock) => {
    vi.stubEnv("PHAROS_API_KEY", "fixture-key");
    vi.stubEnv("PHAROS_DETAIL_SNAPSHOT_SOURCE", "per-coin");
    for (const name of ["DIGEST_API_URL", "PUBLIC_DATASETS_API_URL", "SMOKE_API_BASE", "API_BASE_URL"]) vi.stubEnv(name, "");
    const now = 1_800_000_000_000;
    const sourceClock = 1_799_999_900;
    const detail = { price: 1, priceSource: "coingecko", tokens: [
      { date: sourceClock, totalCirculatingUSD: { peggedUSD: 100 }, totalCirculating: { peggedUSD: 100 } },
    ] };
    const history = [{ date: sourceClock, circulatingUsd: 100, price: 1 }];
    // Origin provenance also survives the one-second loss in legacy Date/age arithmetic.
    const headers = new Headers({ Date: new Date((sourceClock + 1200 + Number(originClock)) * 1000).toUTCString(), Age: "1200" });
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
    expect(perCoinIds).toEqual([unavailableId, unavailableId]);
    expect(peakBulkBodies).toBe(6);
    expect(pendingBulkBodies).toBe(0);
    expect(batches.every((ids) => ids.length <= DETAIL_SNAPSHOT_INPUT_BATCH_SIZE)).toBe(true);
    expect(batches.flat()).toEqual(TRACKED_STABLECOINS
      .filter((coin) => coin.status == null || coin.status === "active" || coin.status === "frozen").map((coin) => coin.id));
  });

  it("rejects malformed or incomplete bulk accounting without silently falling back", async () => {
    vi.stubEnv("PHAROS_API_KEY", "fixture-key");
    for (const name of ["DIGEST_API_URL", "PUBLIC_DATASETS_API_URL", "SMOKE_API_BASE", "API_BASE_URL"]) vi.stubEnv(name, "");
    const fetch = vi.fn(async () => Response.json({ version: 1, entries: [{
      id: "not-requested", status: "unavailable", reason: "detail-cache-missing",
      sources: { detailCacheUpdatedAt: null, publicationUpdatedAt: null, supplySnapshotUpdatedAt: null, supplySnapshotDate: null },
    }] }));
    vi.stubGlobal("fetch", fetch);
    await expect(generateSnapshots(false, { source: "bulk" })).rejects.toThrow(/account for every requested coin/);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it("rejects an unknown source instead of changing the acquisition policy", async () => {
    vi.stubEnv("PHAROS_API_KEY", "fixture-key");
    vi.stubEnv("PHAROS_DETAIL_SNAPSHOT_SOURCE", "typo");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(generateSnapshots(false)).rejects.toThrow(/Invalid PHAROS_DETAIL_SNAPSHOT_SOURCE/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
