import { describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { mockRegistry } from "../../test-helpers/cron";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import * as activeSafetyScoreSource from "../../lib/safety-score-active-source";
import { SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "../../lib/safety-score-v9-consumer-freshness";
import {
  makeWorkerReportCardsV9Response,
  makeWorkerV9Card,
} from "../../test-helpers/report-cards-v9";

vi.mock("@shared/lib/stablecoins/registry", () => mockRegistry({
  stablecoins: [
    { id: "usdt-tether", flags: { backing: "rwa-backed" }, commodityOunces: undefined },
    { id: "usdc-circle", flags: { backing: "rwa-backed" }, commodityOunces: undefined },
    { id: "dai-makerdao", flags: { backing: "crypto-backed" }, commodityOunces: undefined },
  ],
}));

vi.mock("@shared/lib/stablecoins/aggregate-registry", () => ({
  CORE_AGGREGATE_ACTIVE_IDS: new Set(["usdt-tether", "usdc-circle", "dai-makerdao"]),
  CORE_AGGREGATE_ACTIVE_STABLECOINS: [],
  CORE_AGGREGATE_ACTIVE_META_BY_ID: new Map(),
}));

import { handleChains } from "../chains";

function publishedStablecoins(peggedAssets: unknown[]) {
  return {
    peggedAssets: peggedAssets.map((asset) => ({
      pegMechanism: "test-fixture",
      priceSource: "test-fixture",
      chainCirculating: {},
      chains: [],
      ...(asset as Record<string, unknown>),
    })),
  };
}

function stablecoinsCache(peggedAssets: unknown[], ageSeconds = 60) {
  return {
    match: "cache",
    matchBinds: ["stablecoins"],
    rows: [],
    first: {
      key: "stablecoins",
      value: JSON.stringify(publishedStablecoins(peggedAssets)),
      updated_at: Math.floor(Date.now() / 1000) - ageSeconds,
    },
  };
}

function asset(
  id: string,
  chainCirculating: Record<string, { current: number }>,
  overrides: Record<string, unknown> = {},
) {
  const completeChainCirculating = Object.fromEntries(
    Object.entries(chainCirculating).map(([chain, row]) => [
      chain,
      {
        current: row.current,
        circulatingPrevDay: row.current,
        circulatingPrevWeek: row.current,
        circulatingPrevMonth: row.current,
      },
    ]),
  );
  return makeAsset({
    id,
    name: id,
    symbol: id.toUpperCase(),
    pegType: "peggedUSD",
    price: 1,
    circulating: { peggedUSD: Object.values(chainCirculating).reduce((sum, row) => sum + row.current, 0) },
    chainCirculating: completeChainCirculating,
    chains: Object.keys(chainCirculating),
    ...overrides,
  });
}

function activeV9(options: {
  updatedAt?: number;
  held?: boolean;
} = {}) {
  const updatedAt = options.updatedAt ?? Math.floor(Date.now() / 1000) - 60;
  const snapshot = makeWorkerReportCardsV9Response({
    asOfSec: updatedAt - 60,
    updatedAt,
    cards: [
      makeWorkerV9Card({ id: "usdt-tether", score: 90, grade: "A" }),
      makeWorkerV9Card({ id: "usdc-circle", score: 80, grade: "A-" }),
      makeWorkerV9Card({ id: "dai-makerdao", score: 70, grade: "B" }),
    ],
  });
  if (options.held) {
    snapshot.publicationHealth = {
      ...snapshot.publicationHealth,
      status: "held",
      heldSinceSec: updatedAt,
      attemptedAtSec: updatedAt + 60,
      reasons: [{ code: "assessment-failed", detail: "test hold" }],
    };
    return {
      kind: "held" as const,
      reason: "v9-publication-held" as const,
      detail: "Canonical Safety Score V9 ratings are held at the last verified snapshot",
      snapshot,
    };
  }
  return {
    kind: "v9" as const,
    snapshot,
  };
}

describe("handleChains", () => {
  it("returns 503 when the stablecoins cache is missing", async () => {
    const response = await handleChains(mockD1([
      { match: "FROM cache WHERE key = ?", matchBinds: ["stablecoins"], rows: [] },
    ]));
    expect(response.status).toBe(503);
  });

  it("returns 503 when the stablecoins cache does not satisfy the published contract", async () => {
    const db = mockD1([{
      match: "cache",
      matchBinds: ["stablecoins"],
      rows: [],
      first: {
        key: "stablecoins",
        value: JSON.stringify({ peggedAssets: [{ id: "usdc-circle" }] }),
        updated_at: Math.floor(Date.now() / 1000) - 60,
      },
    }]);
    const response = await handleChains(db);
    expect(response.status).toBe(503);
  });

  it("sorts chains and derives health only from the canonical V9 publication", async () => {
    vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreSource").mockResolvedValue(activeV9());
    const db = mockD1([
      stablecoinsCache([
        asset("usdt-tether", { Ethereum: { current: 500 }, Tron: { current: 100 } }),
        asset("usdc-circle", { Ethereum: { current: 100 }, Base: { current: 200 } }),
      ]),
    ]);

    const response = await handleChains(db);
    const body = await response.json() as {
      chains: Array<{ id: string; healthScore: number | null; totalUsd: number }>;
      safetyScoreIdentity: { model: string } | null;
      _meta: { status: string; dependencies: { reportCards: { status: string } } };
    };

    expect(response.status).toBe(200);
    expect(body.chains.map((chain) => chain.id)).toEqual(["ethereum", "base", "tron"]);
    expect(body.chains[0]).toMatchObject({ totalUsd: 600, healthScore: expect.any(Number) });
    expect(body.safetyScoreIdentity).toMatchObject({ model: "v9" });
    expect(body._meta).toMatchObject({
      status: "fresh",
      dependencies: { reportCards: { status: "fresh" } },
    });
  });

  it("fails closed when the canonical V9 publication is unavailable", async () => {
    vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreSource").mockResolvedValue({
      kind: "error",
      reason: "v9-snapshot-unavailable",
      snapshot: null,
      detail: "missing",
    });
    const db = mockD1([stablecoinsCache([asset("usdc-circle", { Ethereum: { current: 100 } })])]);

    const response = await handleChains(db);
    const body = await response.json() as {
      chains: Array<{ healthScore: number | null }>;
      safetyScoreIdentity: unknown;
      _meta: { status: string; dependencies: { reportCards: { status: string; reason: string } } };
    };

    expect(body.chains[0]?.healthScore).toBeNull();
    expect(body.safetyScoreIdentity).toBeNull();
    expect(body._meta).toMatchObject({
      status: "degraded",
      dependencies: {
        reportCards: { status: "unavailable", reason: "v9-snapshot-unavailable" },
      },
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it.each([
    ["held", activeV9({ held: true }), "degraded", "publication-held"],
    [
      "stale",
      activeV9({
        updatedAt:
          Math.floor(Date.now() / 1000) -
          SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC -
          1,
      }),
      "stale",
      "stale-cache",
    ],
  ])("withholds health from a %s V9 publication", async (_label, source, status, reason) => {
    vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreSource").mockResolvedValue(source);
    const db = mockD1([stablecoinsCache([asset("usdc-circle", { Ethereum: { current: 100 } })])]);

    const response = await handleChains(db);
    const body = await response.json() as {
      chains: Array<{ healthScore: number | null }>;
      _meta: { dependencies: { reportCards: { status: string; reason: string } } };
    };

    expect(body.chains[0]?.healthScore).toBeNull();
    expect(body._meta.dependencies.reportCards).toMatchObject({ status, reason });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("degrades an old stablecoins snapshot independently of current V9 safety", async () => {
    vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreSource").mockResolvedValue(activeV9());
    const db = mockD1([
      stablecoinsCache(
        [asset("usdc-circle", { Ethereum: { current: 100 } })],
        1_801,
      ),
    ]);

    const response = await handleChains(db);
    const body = await response.json() as { _meta: { status: string } };
    expect(body._meta.status).toBe("degraded");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("excludes frozen and non-active assets from live aggregation", async () => {
    vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreSource").mockResolvedValue(activeV9());
    const db = mockD1([
      stablecoinsCache([
        asset("usdc-circle", { Ethereum: { current: 100 } }),
        asset("usdt-tether", { Tron: { current: 200 } }, { frozen: true }),
        asset("untracked", { Base: { current: 300 } }),
      ]),
    ]);

    const response = await handleChains(db);
    const body = await response.json() as { chains: Array<{ id: string }> };
    expect(body.chains.map((chain) => chain.id)).toEqual(["ethereum"]);
  });
});
