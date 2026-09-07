import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { StablecoinDetailResponseSchema, SupplyHistoryResponseSchema } from "@shared/types/market";
import {
  projectStablecoinLiveSummary,
  type StablecoinLiveSummary,
} from "../../../src/lib/api-query-descriptors";
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
      rmSync(firstPath);
      expect(() => checkSnapshots(outputDir)).toThrow(/Missing stablecoin detail snapshot/);
      writeSnapshots(snapshots, outputDir);
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
    expect(snapshot.updatedAt).toEqual({ liveSummary: 1_700_000_000_000, supplyHistory: 1_699_996_400_000 });
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

  it("attaches the build API key and omits an authenticated 401 lane", async () => {
    vi.stubEnv("PHAROS_API_KEY", "fixture-key");
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response("valid X-API-Key required", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(fetchOptionalDetailSnapshotLane(
      "coin detail for usdt-tether",
      "https://api.pharos.watch/api/stablecoin/usdt-tether",
      StablecoinDetailResponseSchema,
    )).resolves.toBeNull();

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(requestInit.headers).toMatchObject({ "X-API-Key": "fixture-key" });
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("HTTP 401"));
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

  it("omits a schema-invalid 200 response and still emits every coin", async () => {
    vi.stubEnv("PHAROS_API_KEY", "fixture-key");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ price: "invalid", tokens: [] })));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const invalidDetail = await fetchOptionalDetailSnapshotLane(
      "coin detail for usdt-tether",
      "https://api.pharos.watch/api/stablecoin/usdt-tether",
      StablecoinDetailResponseSchema,
    );
    const snapshots = buildStablecoinDetailSnapshots({
      generatedAt: 1_700_000_000_000,
      updatedAtById: new Map(),
      liveSummariesById: new Map([
        ["usdt-tether", invalidDetail ? projectStablecoinLiveSummary(invalidDetail.data) : null],
        ["usdc-circle", liveSummary()],
      ]),
      supplyHistoryById: new Map(),
    });

    expect(invalidDetail).toBeNull();
    expect(snapshots).toHaveLength(TRACKED_STABLECOINS.length);
    expect(snapshots.find((snapshot) => snapshot.stablecoinId === "usdt-tether")?.lanes).toEqual({});
    expect(snapshots.find((snapshot) => snapshot.stablecoinId === "usdc-circle")?.lanes.liveSummary)
      .toEqual(liveSummary());
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0]?.[0]).toContain("price");
  });

  it("omits a schema-invalid optional supply response", async () => {
    vi.stubEnv("PHAROS_API_KEY", "fixture-key");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ points: [] })));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(fetchOptionalDetailSnapshotLane(
      "supply history for usdt-tether",
      "https://api.pharos.watch/api/supply-history?stablecoin=usdt-tether&days=90",
      SupplyHistoryResponseSchema,
    )).resolves.toBeNull();

    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0]?.[0]).toContain("supply history for usdt-tether");
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

  it("drops supply before an oversized compact lane and permits an empty envelope", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
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
    expect(warning.mock.calls.map(([message]) => String(message))).toEqual([
      expect.stringContaining("Omitting supply history"),
      expect.stringContaining("Omitting live summary"),
    ]);
  });
});
