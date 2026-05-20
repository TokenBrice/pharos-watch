import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KVNamespace, KVNamespaceGetOptions } from "@cloudflare/workers-types";
import { onRequest } from "../selector-snapshot/[[path]].ts";

interface TestKVNamespace extends KVNamespace {
  __getStore(): Map<string, string>;
  __setReadHandler(handler: ((key: string) => string | null | Promise<string | null>) | null): void;
  __setWriteHandler(handler: ((key: string, value: string) => void | Promise<void>) | null): void;
}

function makeKV(): TestKVNamespace {
  const store = new Map<string, string>();
  let readHandler: ((key: string) => string | null | Promise<string | null>) | null = null;
  let writeHandler: ((key: string, value: string) => void | Promise<void>) | null = null;

  const ns: Partial<TestKVNamespace> = {
    get: (async (key: string, _options?: KVNamespaceGetOptions<"text">) => {
      if (readHandler) {
        return readHandler(key);
      }
      return store.has(key) ? (store.get(key) ?? null) : null;
    }) as KVNamespace["get"],
    put: (async (key: string, value: string) => {
      if (writeHandler) {
        await writeHandler(key, value);
      }
      store.set(key, value);
    }) as KVNamespace["put"],
    delete: (async (key: string) => {
      store.delete(key);
    }) as KVNamespace["delete"],
    list: (async () => ({ keys: [], list_complete: true, cacheStatus: null })) as KVNamespace["list"],
    __getStore: () => store,
    __setReadHandler: (handler) => { readHandler = handler; },
    __setWriteHandler: (handler) => { writeHandler = handler; },
  };

  return ns as TestKVNamespace;
}

interface MakeEnvOverrides {
  SELECTOR_SNAPSHOTS?: KVNamespace | undefined;
  SITE_ORIGIN?: string;
  OPS_UI_ORIGIN?: string;
}

function makeEnv(overrides: MakeEnvOverrides = {}) {
  const kvProvided = Object.prototype.hasOwnProperty.call(overrides, "SELECTOR_SNAPSHOTS");
  const kv = kvProvided ? overrides.SELECTOR_SNAPSHOTS : makeKV();
  return {
    SELECTOR_SNAPSHOTS: kv,
    SITE_ORIGIN: overrides.SITE_ORIGIN ?? "https://pharos.watch",
    OPS_UI_ORIGIN: overrides.OPS_UI_ORIGIN ?? "https://ops.pharos.watch",
  };
}

function buildRecommendation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "usdc-circle",
    symbol: "USDC",
    name: "USD Coin",
    profile: "treasury",
    rank: 1,
    score: 87.4,
    confidence: 92,
    components: [],
    whyKeys: ["top-safety"],
    lowestSubDimension: {
      key: "dependencyRisk",
      score: 84,
      contextKeys: [],
    },
    chainHints: {
      topByLiquidity: ["ethereum"],
      topByYield: [],
      primary: "ethereum",
    },
    isRecentListing: false,
    bluechipGrade: "A",
    safetyGrade: "A",
    supplyUsd: 34000000000,
    isBeta: true,
    recommendedSource: null,
    perInputStaleness: null,
    ...overrides,
  };
}

function buildSelectorOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    profile: "treasury",
    engineVersion: "selector-v1.2",
    datasetHash: "abc123",
    timestamp: 1715000000,
    input: {
      profile: "treasury",
      pegCurrency: "USD",
      horizon: "6mplus",
      depegTolerance: "zero",
      composability: "moderate",
      exitSpeed: "any",
      minApy: null,
      yieldNativeOnly: false,
      decentralization: "any",
      custodyOk: "any",
    },
    universe: { active: 392, surviving: 12 },
    recommended: [buildRecommendation()],
    lowerRanked: [],
    coverageWarnings: {
      skippedForCoverageCount: 0,
      sparse: false,
      uneven: false,
      skippedForCoverage: [],
      newListingCount: 0,
      redistributionCount: 0,
    },
    lowConfidence: false,
    methodologyVersions: {
      safetyScore: "v7.25",
      pegScoreAndDews: "v5.9",
      yieldIntelligence: "v8.0",
      bluechipAlignment: "v1.0",
      exclusionFilters: "selector-v1.2",
    },
    ...overrides,
  };
}

describe("selector-snapshot Pages Function", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("origin gating", () => {
    it("rejects POST without Origin/Referer", async () => {
      const response = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot", {
          method: "POST",
          body: JSON.stringify(buildSelectorOutput()),
          headers: { "Content-Type": "application/json" },
        }),
        env: makeEnv(),
        params: {},
      });
      expect(response.status).toBe(404);
    });

    it("rejects GET without Origin/Referer", async () => {
      const response = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot/00112233445566778899aabbccddeeff"),
        env: makeEnv(),
        params: { path: "00112233445566778899aabbccddeeff" },
      });
      expect(response.status).toBe(404);
    });

    it("rejects POST from foreign origin", async () => {
      const response = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot", {
          method: "POST",
          body: JSON.stringify(buildSelectorOutput()),
          headers: { "Content-Type": "application/json", Origin: "https://evil.example.com" },
        }),
        env: makeEnv(),
        params: {},
      });
      expect(response.status).toBe(404);
    });

    it("accepts POST from allowlisted ops origin", async () => {
      const response = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot", {
          method: "POST",
          body: JSON.stringify(buildSelectorOutput()),
          headers: { "Content-Type": "application/json", Origin: "https://ops.pharos.watch" },
        }),
        env: makeEnv(),
        params: {},
      });
      expect(response.status).toBe(200);
    });

    it("accepts requests when Origin is missing but Referer is allowlisted", async () => {
      const response = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot", {
          method: "POST",
          body: JSON.stringify(buildSelectorOutput()),
          headers: { "Content-Type": "application/json", Referer: "https://pharos.watch/screener/selector/" },
        }),
        env: makeEnv(),
        params: {},
      });
      expect(response.status).toBe(200);
    });
  });

  describe("POST happy path", () => {
    it("stores the payload and returns a 32-hex sid", async () => {
      const env = makeEnv();
      const response = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot", {
          method: "POST",
          body: JSON.stringify(buildSelectorOutput()),
          headers: { "Content-Type": "application/json", Origin: "https://pharos.watch" },
        }),
        env,
        params: {},
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const body = (await response.json()) as { sid: string };
      expect(body.sid).toMatch(/^[0-9a-f]{32}$/);
      const kv = env.SELECTOR_SNAPSHOTS as TestKVNamespace;
      expect(kv.__getStore().has(`s:${body.sid}`)).toBe(true);
    });

    it("accepts non-USD selector input snapshots", async () => {
      const output = buildSelectorOutput();
      const input = { ...(output.input as Record<string, unknown>), pegCurrency: "EUR" };
      const response = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot", {
          method: "POST",
          body: JSON.stringify(buildSelectorOutput({ input })),
          headers: { "Content-Type": "application/json", Origin: "https://pharos.watch" },
        }),
        env: makeEnv(),
        params: {},
      });
      expect(response.status).toBe(200);
    });

    it("is idempotent — re-POSTing the same payload returns the same sid", async () => {
      const env = makeEnv();
      const headers = { "Content-Type": "application/json", Origin: "https://pharos.watch" } as const;
      const output = buildSelectorOutput();

      const first = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot", {
          method: "POST",
          body: JSON.stringify(output),
          headers,
        }),
        env,
        params: {},
      });
      const firstBody = (await first.json()) as { sid: string };

      const second = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot", {
          method: "POST",
          body: JSON.stringify(output),
          headers,
        }),
        env,
        params: {},
      });
      const secondBody = (await second.json()) as { sid: string };

      expect(secondBody.sid).toBe(firstBody.sid);
    });

    it("ignores the timestamp field when computing the sid", async () => {
      const env = makeEnv();
      const headers = { "Content-Type": "application/json", Origin: "https://pharos.watch" } as const;

      const first = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot", {
          method: "POST",
          body: JSON.stringify(buildSelectorOutput({ timestamp: 1000000000 })),
          headers,
        }),
        env,
        params: {},
      });
      const firstBody = (await first.json()) as { sid: string };

      const second = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot", {
          method: "POST",
          body: JSON.stringify(buildSelectorOutput({ timestamp: 9999999999 })),
          headers,
        }),
        env,
        params: {},
      });
      const secondBody = (await second.json()) as { sid: string };

      expect(secondBody.sid).toBe(firstBody.sid);
    });

    it("strips freshness-suffix fields from the sid computation", async () => {
      const env = makeEnv();
      const headers = { "Content-Type": "application/json", Origin: "https://pharos.watch" } as const;

      const withoutFreshness = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot", {
          method: "POST",
          body: JSON.stringify(buildSelectorOutput()),
          headers,
        }),
        env,
        params: {},
      });
      const withoutBody = (await withoutFreshness.json()) as { sid: string };

      const withFreshness = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot", {
          method: "POST",
          body: JSON.stringify(
            buildSelectorOutput({
              recommended: [
                buildRecommendation({
                  recommendedSource: {
                    venue: "aave",
                    freshness: { capturedAt: 1715000123, ageSeconds: 42 },
                  },
                }),
              ],
            }),
          ),
          headers,
        }),
        env,
        params: {},
      });
      const withBody = (await withFreshness.json()) as { sid: string };

      expect(withBody.sid).not.toBe(withoutBody.sid);

      // Two payloads that differ only in capturedAt/ageSeconds should produce identical sids.
      const variantA = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot", {
          method: "POST",
          body: JSON.stringify(
            buildSelectorOutput({
              recommended: [
                buildRecommendation({
                  recommendedSource: {
                    venue: "aave",
                    freshness: { capturedAt: 1715000123, ageSeconds: 42 },
                  },
                }),
              ],
            }),
          ),
          headers,
        }),
        env,
        params: {},
      });
      const variantB = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot", {
          method: "POST",
          body: JSON.stringify(
            buildSelectorOutput({
              recommended: [
                buildRecommendation({
                  recommendedSource: {
                    venue: "aave",
                    freshness: { capturedAt: 1799999999, ageSeconds: 9999 },
                  },
                }),
              ],
            }),
          ),
          headers,
        }),
        env,
        params: {},
      });
      const variantABody = (await variantA.json()) as { sid: string };
      const variantBBody = (await variantB.json()) as { sid: string };
      expect(variantABody.sid).toBe(variantBBody.sid);
    });
  });

  describe("POST failure modes", () => {
    it("returns 400 on malformed JSON", async () => {
      const response = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot", {
          method: "POST",
          body: "not-json",
          headers: { "Content-Type": "application/json", Origin: "https://pharos.watch" },
        }),
        env: makeEnv(),
        params: {},
      });
      expect(response.status).toBe(400);
    });

    it("returns 400 when the body is missing required fields", async () => {
      const response = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot", {
          method: "POST",
          body: JSON.stringify({ profile: "treasury" }),
          headers: { "Content-Type": "application/json", Origin: "https://pharos.watch" },
        }),
        env: makeEnv(),
        params: {},
      });
      expect(response.status).toBe(400);
    });

    it("returns 400 when the selector input is missing pegCurrency", async () => {
      const output = buildSelectorOutput();
      const input = { ...(output.input as Record<string, unknown>) };
      delete input.pegCurrency;
      const response = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot", {
          method: "POST",
          body: JSON.stringify(buildSelectorOutput({ input })),
          headers: { "Content-Type": "application/json", Origin: "https://pharos.watch" },
        }),
        env: makeEnv(),
        params: {},
      });
      expect(response.status).toBe(400);
    });

    it("returns 400 when frontend-required output fields are missing", async () => {
      const response = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot", {
          method: "POST",
          body: JSON.stringify(buildSelectorOutput({ universe: undefined })),
          headers: { "Content-Type": "application/json", Origin: "https://pharos.watch" },
        }),
        env: makeEnv(),
        params: {},
      });
      expect(response.status).toBe(400);
    });

    it("returns 400 when coverage warning counts are missing", async () => {
      const coverageWarnings = {
        sparse: false,
        uneven: false,
        skippedForCoverage: [],
      };
      const response = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot", {
          method: "POST",
          body: JSON.stringify(buildSelectorOutput({ coverageWarnings })),
          headers: { "Content-Type": "application/json", Origin: "https://pharos.watch" },
        }),
        env: makeEnv(),
        params: {},
      });
      expect(response.status).toBe(400);
    });

    it("returns 400 when recommendations are missing frontend basics", async () => {
      const response = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot", {
          method: "POST",
          body: JSON.stringify(buildSelectorOutput({ recommended: [{ id: "usdc-circle" }] })),
          headers: { "Content-Type": "application/json", Origin: "https://pharos.watch" },
        }),
        env: makeEnv(),
        params: {},
      });
      expect(response.status).toBe(400);
    });

    it("returns 413 when Content-Length advertises an oversized payload", async () => {
      const response = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot", {
          method: "POST",
          body: JSON.stringify(buildSelectorOutput()),
          headers: {
            "Content-Type": "application/json",
            Origin: "https://pharos.watch",
            "Content-Length": String(200 * 1024),
          },
        }),
        env: makeEnv(),
        params: {},
      });
      expect(response.status).toBe(413);
    });

    it("returns 413 when the body itself exceeds the size cap", async () => {
      const oversized = buildSelectorOutput({
        recommended: Array.from({ length: 5000 }, (_v, i) => ({
          id: `coin-${i}`,
          rank: i + 1,
          score: 50,
          confidence: 70,
          whyKeys: ["top-safety"],
        })),
      });
      const response = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot", {
          method: "POST",
          body: JSON.stringify(oversized),
          headers: { "Content-Type": "application/json", Origin: "https://pharos.watch" },
        }),
        env: makeEnv(),
        params: {},
      });
      expect(response.status).toBe(413);
    });

    it("returns 500 when the KV binding is missing", async () => {
      const response = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot", {
          method: "POST",
          body: JSON.stringify(buildSelectorOutput()),
          headers: { "Content-Type": "application/json", Origin: "https://pharos.watch" },
        }),
        env: makeEnv({ SELECTOR_SNAPSHOTS: undefined }),
        params: {},
      });
      expect(response.status).toBe(500);
    });

    it("returns 503 when the KV write fails", async () => {
      const kv = makeKV();
      kv.__setWriteHandler(() => {
        throw new Error("kv unavailable");
      });
      const response = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot", {
          method: "POST",
          body: JSON.stringify(buildSelectorOutput()),
          headers: { "Content-Type": "application/json", Origin: "https://pharos.watch" },
        }),
        env: makeEnv({ SELECTOR_SNAPSHOTS: kv }),
        params: {},
      });
      expect(response.status).toBe(503);
    });

    it("returns 405 when POST is sent with a sid segment", async () => {
      const response = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot/00112233445566778899aabbccddeeff", {
          method: "POST",
          body: JSON.stringify(buildSelectorOutput()),
          headers: { "Content-Type": "application/json", Origin: "https://pharos.watch" },
        }),
        env: makeEnv(),
        params: { path: "00112233445566778899aabbccddeeff" },
      });
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET");
    });
  });

  describe("GET happy path", () => {
    it("returns the stored payload byte-for-byte", async () => {
      const env = makeEnv();
      const post = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot", {
          method: "POST",
          body: JSON.stringify(buildSelectorOutput()),
          headers: { "Content-Type": "application/json", Origin: "https://pharos.watch" },
        }),
        env,
        params: {},
      });
      const { sid } = (await post.json()) as { sid: string };

      const get = await onRequest({
        request: new Request(`https://pharos.watch/selector-snapshot/${sid}`, {
          headers: { Origin: "https://pharos.watch" },
        }),
        env,
        params: { path: sid },
      });
      expect(get.status).toBe(200);
      expect(get.headers.get("Cache-Control")).toBe("private, no-store");
      const body = (await get.json()) as Record<string, unknown>;
      expect(body.profile).toBe("treasury");
      expect(body.timestamp).toBe(1715000000);
      expect(body.universe).toEqual({ active: 392, surviving: 12 });
      expect(body.lowConfidence).toBe(false);
    });
  });

  describe("GET failure modes", () => {
    it("returns 404 for an unknown sid", async () => {
      const env = makeEnv();
      const response = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot/00112233445566778899aabbccddeeff", {
          headers: { Origin: "https://pharos.watch" },
        }),
        env,
        params: { path: "00112233445566778899aabbccddeeff" },
      });
      expect(response.status).toBe(404);
    });

    it("returns 404 when the sid is not 32 hex chars", async () => {
      const response = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot/not-a-sid", {
          headers: { Origin: "https://pharos.watch" },
        }),
        env: makeEnv(),
        params: { path: "not-a-sid" },
      });
      expect(response.status).toBe(404);
    });

    it("returns 502 when the stored KV value is corrupt JSON", async () => {
      const kv = makeKV();
      kv.__setReadHandler(() => "{not valid json}");
      const response = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot/00112233445566778899aabbccddeeff", {
          headers: { Origin: "https://pharos.watch" },
        }),
        env: makeEnv({ SELECTOR_SNAPSHOTS: kv }),
        params: { path: "00112233445566778899aabbccddeeff" },
      });
      expect(response.status).toBe(502);
    });

    it("returns 502 when the stored KV value is valid JSON but the wrong shape", async () => {
      const kv = makeKV();
      kv.__setReadHandler(() => JSON.stringify({ wrong: "shape" }));
      const response = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot/00112233445566778899aabbccddeeff", {
          headers: { Origin: "https://pharos.watch" },
        }),
        env: makeEnv({ SELECTOR_SNAPSHOTS: kv }),
        params: { path: "00112233445566778899aabbccddeeff" },
      });
      expect(response.status).toBe(502);
    });

    it("returns 503 when the KV read throws", async () => {
      const kv = makeKV();
      kv.__setReadHandler(() => {
        throw new Error("kv read failed");
      });
      const response = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot/00112233445566778899aabbccddeeff", {
          headers: { Origin: "https://pharos.watch" },
        }),
        env: makeEnv({ SELECTOR_SNAPSHOTS: kv }),
        params: { path: "00112233445566778899aabbccddeeff" },
      });
      expect(response.status).toBe(503);
    });

    it("returns 500 when the KV binding is missing on GET", async () => {
      const response = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot/00112233445566778899aabbccddeeff", {
          headers: { Origin: "https://pharos.watch" },
        }),
        env: makeEnv({ SELECTOR_SNAPSHOTS: undefined }),
        params: { path: "00112233445566778899aabbccddeeff" },
      });
      expect(response.status).toBe(500);
    });
  });

  describe("unsupported methods", () => {
    it("returns 405 with Allow on PUT", async () => {
      const response = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot", {
          method: "PUT",
          headers: { Origin: "https://pharos.watch" },
        }),
        env: makeEnv(),
        params: {},
      });
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET, POST");
    });

    it("returns 405 with Allow on DELETE", async () => {
      const response = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot/00112233445566778899aabbccddeeff", {
          method: "DELETE",
          headers: { Origin: "https://pharos.watch" },
        }),
        env: makeEnv(),
        params: { path: "00112233445566778899aabbccddeeff" },
      });
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET, POST");
    });
  });
});
