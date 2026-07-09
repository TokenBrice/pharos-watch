import { afterEach, describe, expect, it, vi } from "vitest";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import {
  REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS,
  REDEMPTION_EFFECTIVE_EXIT_MODEL,
  REDEMPTION_ROUTE_FAMILY_CAPS,
} from "@shared/lib/redemption-backstop-scoring";
import { SITE_DATA_PROXY_SECRET_HEADER } from "@shared/lib/site-data-lane";
import type { SelectorInput } from "@shared/lib/selector/types";
import { recomputeVerifiedSelectorSnapshot } from "../lib/selector-canonical-snapshot";

const NOW_MS = 1_700_000_000_000;
const NOW_SEC = NOW_MS / 1_000;
const SITE_API_ORIGIN = "https://site-api.pharos.watch";
const SITE_API_SHARED_SECRET = "selector-canonical-test-secret";

const methodologyEnvelope = {
  version: "v1",
  versionLabel: "v1",
  currentVersion: "v1",
  currentVersionLabel: "v1",
  changelogPath: "/methodology",
  asOf: NOW_SEC,
  isCurrent: true,
};

const validPayloads: Readonly<Record<string, unknown>> = {
  [API_PATHS.stablecoins()]: { peggedAssets: [] },
  [API_PATHS.pegSummary()]: {
    coins: [],
    summary: null,
    methodology: methodologyEnvelope,
  },
  [API_PATHS.reportCards()]: {
    cards: [],
    methodology: {
      version: "7.4",
      weights: {
        pegStability: 20,
        liquidity: 20,
        resilience: 20,
        decentralization: 20,
        dependencyRisk: 20,
      },
      pegMultiplierExponent: 1,
      thresholds: [],
    },
    dependencyGraph: { edges: [] },
    updatedAt: NOW_SEC,
  },
  [API_PATHS.stressSignals()]: {
    signals: {},
    updatedAt: NOW_SEC,
    methodology: methodologyEnvelope,
  },
  [API_PATHS.dexLiquidity()]: {},
  [API_PATHS.yieldRankings()]: {
    rankings: [],
    riskFreeRate: 4,
    scalingFactor: 1,
    medianApy: 0,
    updatedAt: NOW_SEC,
  },
  [API_PATHS.bluechipRatings()]: {},
  [API_PATHS.redemptionBackstops()]: {
    coins: {},
    methodology: {
      ...methodologyEnvelope,
      componentWeights: REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS,
      effectiveExitModel: REDEMPTION_EFFECTIVE_EXIT_MODEL,
      routeFamilyCaps: REDEMPTION_ROUTE_FAMILY_CAPS,
    },
    updatedAt: NOW_SEC,
  },
};

const sourcePaths = Object.keys(validPayloads);

const selectorInput: SelectorInput = {
  profile: "treasury",
  pegCurrency: "USD",
  horizon: "6mplus",
  depegTolerance: "zero",
  composability: "none",
  venuePreferences: ["custody"],
  exitSpeed: "any",
  minApy: null,
  yieldNativeOnly: false,
  decentralization: "any",
  custodyOk: "any",
};

function streamingJsonResponse(payload: unknown, onConsumed: () => void, status = 200): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let emitted = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!emitted) {
          emitted = true;
          controller.enqueue(bytes);
          return;
        }
        onConsumed();
        controller.close();
      },
    }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function recompute(input: SelectorInput = selectorInput) {
  return recomputeVerifiedSelectorSnapshot(
    input,
    new Request("https://pharos.watch/selector-snapshot", { method: "POST" }),
    { SITE_API_ORIGIN, SITE_API_SHARED_SECRET },
    NOW_MS,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("canonical selector snapshot recomputation", () => {
  it("recomputes from canonical sources, strips caller output claims, and drains sources in two batches of four", async () => {
    const started: string[] = [];
    const consumed = new Set<string>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      const path = url.pathname;
      started.push(path);

      if (started.length === 5) {
        expect(consumed).toEqual(new Set(sourcePaths.slice(0, 4)));
      }
      expect(url.origin).toBe(SITE_API_ORIGIN);
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get(SITE_DATA_PROXY_SECRET_HEADER)).toBe(SITE_API_SHARED_SECRET);

      return streamingJsonResponse(validPayloads[path], () => consumed.add(path));
    });
    vi.stubGlobal("fetch", fetchMock);

    const forgedInput = {
      ...selectorInput,
      datasetHash: "f".repeat(64),
      recommended: [{ id: "forged", score: 100 }],
    } as SelectorInput;
    const snapshot = await recompute(forgedInput);

    expect(started).toEqual(sourcePaths);
    expect(consumed).toEqual(new Set(sourcePaths));
    expect(snapshot.datasetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.datasetHash).not.toBe("f".repeat(64));
    expect(snapshot.recommended).toEqual([]);
    expect(snapshot.input).toEqual(selectorInput);
    expect(snapshot).toMatchObject({
      provenance: "pharos-verified",
      snapshotSchemaVersion: 3,
      verification: {
        kind: "pharos-server-recomputed-v1",
        engineVersion: snapshot.engineVersion,
        datasetHash: snapshot.datasetHash,
      },
    });
  });

  it.each(sourcePaths)("schema-validates canonical source %s", async (invalidPath) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(typeof input === "string" ? input : input.toString()).pathname;
      const payload = path === invalidPath ? { invalid: true } : validPayloads[path];
      return new Response(JSON.stringify(payload), {
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(recompute()).rejects.toThrow(`Canonical selector source contract failed: ${invalidPath}`);
  });

  it("fails closed when any canonical source is unavailable", async () => {
    const failedPath = API_PATHS.reportCards();
    const consumed = new Set<string>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(typeof input === "string" ? input : input.toString()).pathname;
      return streamingJsonResponse(
        path === failedPath ? { error: "unavailable" } : validPayloads[path],
        () => consumed.add(path),
        path === failedPath ? 503 : 200,
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(recompute()).rejects.toThrow(`Canonical selector source unavailable: ${failedPath}`);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(consumed).toEqual(new Set(sourcePaths.slice(0, 4)));
  });
});
