import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
  KVNamespace,
  KVNamespaceGetOptions,
} from "@cloudflare/workers-types";
import {
  SELECTOR_SNAPSHOT_TTL_SECONDS,
  SELECTOR_SNAPSHOT_UNREAD_TTL_SECONDS,
  computeSelectorSnapshotSid,
  createVerifiedSelectorSnapshot,
  validateSelectorSnapshot,
} from "../../shared/lib/selector/snapshot";
import { SELECTOR_SNAPSHOT_VERIFICATION_KIND } from "../../shared/lib/selector/types";
import {
  buildSelectorSnapshotOutput,
  buildSnapshotRecommendation,
} from "../../shared/lib/selector/__tests__/snapshot-fixture";

const { recomputeVerifiedSelectorSnapshotMock } = vi.hoisted(() => ({
  recomputeVerifiedSelectorSnapshotMock: vi.fn(),
}));

vi.mock("../lib/selector-canonical-snapshot", () => ({
  recomputeVerifiedSelectorSnapshot: recomputeVerifiedSelectorSnapshotMock,
}));

import { onRequest } from "../selector-snapshot/[[path]].ts";

interface RecordedPutCall {
  key: string;
  options?: { expirationTtl?: number; metadata?: unknown };
}

interface TestKVNamespace extends KVNamespace {
  __getStore(): Map<string, string>;
  __getPutCalls(): RecordedPutCall[];
  __setReadHandler(handler: ((key: string) => string | null | Promise<string | null>) | null): void;
  __setWriteHandler(handler: ((key: string, value: string) => void | Promise<void>) | null): void;
}

function makeKV(): TestKVNamespace {
  const store = new Map<string, string>();
  const metaStore = new Map<string, unknown>();
  const putCalls: RecordedPutCall[] = [];
  let readHandler: ((key: string) => string | null | Promise<string | null>) | null = null;
  let writeHandler: ((key: string, value: string) => void | Promise<void>) | null = null;

  const readValue = async (key: string): Promise<string | null> => {
    if (readHandler) {
      return readHandler(key);
    }
    return store.has(key) ? (store.get(key) ?? null) : null;
  };

  const ns: Partial<TestKVNamespace> = {
    get: (async (key: string, _options?: KVNamespaceGetOptions<"text">) => {
      return readValue(key);
    }) as KVNamespace["get"],
    getWithMetadata: (async (key: string, _options?: KVNamespaceGetOptions<"text">) => {
      return { value: await readValue(key), metadata: metaStore.get(key) ?? null, cacheStatus: null };
    }) as KVNamespace["getWithMetadata"],
    put: (async (key: string, value: string, options?: RecordedPutCall["options"]) => {
      if (writeHandler) {
        await writeHandler(key, value);
      }
      store.set(key, value);
      metaStore.set(key, options?.metadata ?? null);
      putCalls.push({ key, options });
    }) as KVNamespace["put"],
    delete: (async (key: string) => {
      store.delete(key);
      metaStore.delete(key);
    }) as KVNamespace["delete"],
    list: (async () => ({ keys: [], list_complete: true, cacheStatus: null })) as KVNamespace["list"],
    __getStore: () => store,
    __getPutCalls: () => putCalls,
    __setReadHandler: (handler) => {
      readHandler = handler;
    },
    __setWriteHandler: (handler) => {
      writeHandler = handler;
    },
  };

  return ns as TestKVNamespace;
}

interface TestD1Database extends D1Database {
  __getQuotaRows(): Map<string, number>;
  __setRunHandler(handler: (() => void | Promise<void>) | null): void;
}

function makeD1(): TestD1Database {
  const quotaRows = new Map<string, number>();
  let runHandler: (() => void | Promise<void>) | null = null;

  const result = <T>(changes: number): D1Result<T> => ({
    success: true,
    results: [],
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: 0,
      rows_written: changes,
      last_row_id: 0,
      changed_db: changes > 0,
      changes,
    },
  });

  const db: Partial<TestD1Database> = {
    prepare: ((query: string) => {
      let values: unknown[] = [];
      const statement: Partial<D1PreparedStatement> = {
        bind: (...bindValues: unknown[]) => {
          values = bindValues;
          return statement as D1PreparedStatement;
        },
        run: async <T = Record<string, unknown>>() => {
          if (runHandler) await runHandler();
          if (!query.includes("selector_snapshot_daily_quota")) return result<T>(0);
          const [quotaDate, ipHash, , , maxCount] = values as [string, string, number, number, number];
          const key = `${quotaDate}:${ipHash}`;
          const current = quotaRows.get(key) ?? 0;
          if (current >= maxCount) return result<T>(0);
          quotaRows.set(key, current + 1);
          return result<T>(1);
        },
      };
      return statement as D1PreparedStatement;
    }) as D1Database["prepare"],
    __getQuotaRows: () => quotaRows,
    __setRunHandler: (handler) => {
      runHandler = handler;
    },
  };

  return db as TestD1Database;
}

interface MakeEnvOverrides {
  SELECTOR_SNAPSHOTS?: KVNamespace | undefined;
  DB?: D1Database | undefined;
  SITE_ORIGIN?: string;
  OPS_UI_ORIGIN?: string;
  SITE_API_ORIGIN?: string;
  SITE_API_SHARED_SECRET?: string;
  SELECTOR_SNAPSHOT_IP_HASH_SECRET?: string | undefined;
}

function makeEnv(overrides: MakeEnvOverrides = {}) {
  const kvProvided = Object.prototype.hasOwnProperty.call(overrides, "SELECTOR_SNAPSHOTS");
  const dbProvided = Object.prototype.hasOwnProperty.call(overrides, "DB");
  const pepperProvided = Object.prototype.hasOwnProperty.call(overrides, "SELECTOR_SNAPSHOT_IP_HASH_SECRET");
  const kv = kvProvided ? overrides.SELECTOR_SNAPSHOTS : makeKV();
  const db = dbProvided ? overrides.DB : makeD1();
  return {
    SELECTOR_SNAPSHOTS: kv,
    DB: db,
    SITE_ORIGIN: overrides.SITE_ORIGIN ?? "https://pharos.watch",
    OPS_UI_ORIGIN: overrides.OPS_UI_ORIGIN ?? "https://ops.pharos.watch",
    SITE_API_ORIGIN: overrides.SITE_API_ORIGIN ?? "https://site-api.pharos.watch",
    SITE_API_SHARED_SECRET: overrides.SITE_API_SHARED_SECRET ?? "site-api-test-secret",
    SELECTOR_SNAPSHOT_IP_HASH_SECRET: pepperProvided
      ? overrides.SELECTOR_SNAPSHOT_IP_HASH_SECRET
      : "selector-snapshot-test-pepper-32-bytes",
  };
}

const POST_HEADERS = {
  "Content-Type": "application/json",
  Origin: "https://pharos.watch",
} as const;

function postRequest(body: unknown, headers: HeadersInit = POST_HEADERS): Request {
  return new Request("https://pharos.watch/selector-snapshot", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers,
  });
}

function buildVerifiedSnapshot(overrides: Record<string, unknown> = {}) {
  const validation = validateSelectorSnapshot(buildSelectorSnapshotOutput(overrides));
  if (!validation.ok) throw new Error(`Invalid verified snapshot fixture: ${validation.error}`);
  return createVerifiedSelectorSnapshot(validation.snapshot);
}

describe("selector-snapshot Pages Function", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    recomputeVerifiedSelectorSnapshotMock.mockReset();
    recomputeVerifiedSelectorSnapshotMock.mockResolvedValue(buildVerifiedSnapshot());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("origin gating", () => {
    it("rejects POST without Origin/Referer", async () => {
      const response = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot", {
          method: "POST",
          body: JSON.stringify(buildSelectorSnapshotOutput()),
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
        request: postRequest(buildSelectorSnapshotOutput(), {
          "Content-Type": "application/json",
          Origin: "https://evil.example.com",
        }),
        env: makeEnv(),
        params: {},
      });
      expect(response.status).toBe(404);
    });

    it("accepts POST from allowlisted ops origin", async () => {
      const response = await onRequest({
        request: postRequest(buildSelectorSnapshotOutput(), {
          "Content-Type": "application/json",
          Origin: "https://ops.pharos.watch",
        }),
        env: makeEnv(),
        params: {},
      });
      expect(response.status).toBe(200);
    });

    it("accepts requests when Origin is missing but Referer is allowlisted", async () => {
      const response = await onRequest({
        request: postRequest(buildSelectorSnapshotOutput(), {
          "Content-Type": "application/json",
          Referer: "https://pharos.watch/screener/picker/",
        }),
        env: makeEnv(),
        params: {},
      });
      expect(response.status).toBe(200);
    });
  });

  describe("POST storage", () => {
    it("stores a server-recomputed verified payload and returns its binding", async () => {
      const env = makeEnv();
      const response = await onRequest({
        request: postRequest(buildSelectorSnapshotOutput()),
        env,
        params: {},
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const body = (await response.json()) as { sid: string; ev: string };
      expect(body.sid).toMatch(/^[0-9a-f]{32}$/);
      expect(body.ev).toBe(SELECTOR_SNAPSHOT_VERIFICATION_KIND);
      const kv = env.SELECTOR_SNAPSHOTS as TestKVNamespace;
      expect(kv.__getStore().has(`s:${body.sid}`)).toBe(true);
      const stored = JSON.parse(kv.__getStore().get(`s:${body.sid}`) ?? "{}") as Record<string, unknown>;
      expect(stored).toMatchObject({
        provenance: "pharos-verified",
        snapshotSchemaVersion: 3,
        verification: {
          kind: SELECTOR_SNAPSHOT_VERIFICATION_KIND,
          datasetHash: stored.datasetHash,
          engineVersion: stored.engineVersion,
        },
      });
      expect(kv.__getPutCalls()[0]?.options?.metadata).toEqual({
        trust: SELECTOR_SNAPSHOT_VERIFICATION_KIND,
      });
    });

    it("accepts an input-only request and ignores caller-authored output fields", async () => {
      const env = makeEnv();
      const canonical = buildVerifiedSnapshot();
      recomputeVerifiedSelectorSnapshotMock.mockResolvedValueOnce(canonical);
      const forged = buildSelectorSnapshotOutput({
        datasetHash: "f".repeat(64),
        recommended: [buildSnapshotRecommendation({ score: 100, name: "Official Pharos winner" })],
        provenance: "pharos-verified",
        snapshotSchemaVersion: 3,
        verification: {
          kind: SELECTOR_SNAPSHOT_VERIFICATION_KIND,
          datasetHash: "f".repeat(64),
          engineVersion: buildSelectorSnapshotOutput().engineVersion,
        },
      });

      const forgedResponse = await onRequest({ request: postRequest(forged), env, params: {} });
      const inputOnlyResponse = await onRequest({ request: postRequest({ input: forged.input }), env, params: {} });
      const forgedBody = (await forgedResponse.json()) as { sid: string };
      const inputOnlyBody = (await inputOnlyResponse.json()) as { sid: string };

      expect(forgedResponse.status).toBe(200);
      expect(inputOnlyResponse.status).toBe(200);
      expect(forgedBody.sid).toBe(inputOnlyBody.sid);
      expect(recomputeVerifiedSelectorSnapshotMock).toHaveBeenCalledWith(
        canonical.input,
        expect.any(Request),
        expect.any(Object),
      );
      const stored = JSON.parse(
        (env.SELECTOR_SNAPSHOTS as TestKVNamespace).__getStore().get(`s:${forgedBody.sid}`) ?? "{}",
      ) as typeof canonical;
      expect(stored.datasetHash).toBe(canonical.datasetHash);
      expect(stored.recommended[0]?.score).toBe(canonical.recommended[0]?.score);
      expect(stored.recommended[0]?.name).toBe(canonical.recommended[0]?.name);
      expect(stored.verification).toEqual(canonical.verification);
    });

    it("does not deduplicate against an untrusted value at the verified sid", async () => {
      const env = makeEnv();
      const canonical = buildVerifiedSnapshot();
      const sid = computeSelectorSnapshotSid(canonical);
      const kv = env.SELECTOR_SNAPSHOTS as TestKVNamespace;
      await kv.put(
        `s:${sid}`,
        JSON.stringify({
          ...canonical,
          provenance: "client-unverified",
          snapshotSchemaVersion: 2,
          verification: undefined,
        }),
      );

      const response = await onRequest({
        request: postRequest({ input: canonical.input }),
        env,
        params: {},
      });

      expect(response.status).toBe(200);
      expect(kv.__getPutCalls()).toHaveLength(2);
      expect(kv.__getPutCalls()[1]?.options?.metadata).toEqual({
        trust: SELECTOR_SNAPSHOT_VERIFICATION_KIND,
      });
      expect(JSON.parse(kv.__getStore().get(`s:${sid}`) ?? "{}")).toEqual(canonical);
    });

    it("strips debug before storing snapshots", async () => {
      const env = makeEnv();
      const output = buildSelectorSnapshotOutput();
      const withDebug = {
        ...output,
        debug: { allSurvivors: [buildSnapshotRecommendation({ id: "debug-only", symbol: "DBG" })] },
      };

      const debug = await onRequest({
        request: postRequest(withDebug),
        env,
        params: {},
      });
      const debugBody = (await debug.json()) as { sid: string };
      const kv = env.SELECTOR_SNAPSHOTS as TestKVNamespace;
      const stored = JSON.parse(kv.__getStore().get(`s:${debugBody.sid}`) ?? "{}") as Record<string, unknown>;
      expect(stored.debug).toBeUndefined();

      const plain = await onRequest({
        request: postRequest(output),
        env,
        params: {},
      });
      const plainBody = (await plain.json()) as { sid: string };
      expect(debugBody.sid).toBe(plainBody.sid);
    });

    it("strips caller-authored prose before storing snapshots", async () => {
      const env = makeEnv();
      const output = buildSelectorSnapshotOutput({
        recommended: [
          buildSnapshotRecommendation({
            whyText: "Attacker-authored recommendation prose.",
            watchText: "Attacker-authored watch prose.",
          }),
        ],
        lowerRanked: [
          {
            id: "usdt-tether",
            symbol: "USDT",
            name: "Tether USD",
            slot: "A",
            reasonKey: "weak-liquidity",
            failedComponent: "liquidity",
            hypotheticalScore: 70,
            verdictText: "Attacker-authored verdict.",
            teachingText: "Attacker-authored teaching copy.",
          },
        ],
      });

      const response = await onRequest({
        request: postRequest(output),
        env,
        params: {},
      });
      const { sid } = (await response.json()) as { sid: string };
      const kv = env.SELECTOR_SNAPSHOTS as TestKVNamespace;
      const stored = JSON.parse(kv.__getStore().get(`s:${sid}`) ?? "{}") as Record<string, unknown>;
      const recommended = stored.recommended as Array<Record<string, unknown>>;
      const lowerRanked = stored.lowerRanked as Array<Record<string, unknown>>;

      expect(recommended[0]?.whyText).toBeUndefined();
      expect(recommended[0]?.watchText).toBeUndefined();
      expect(lowerRanked[0]?.verdictText).toBeUndefined();
      expect(lowerRanked[0]?.teachingText).toBeUndefined();
    });

    it("is idempotent when re-POSTing the same payload", async () => {
      const env = makeEnv();
      const output = buildSelectorSnapshotOutput();

      const first = await onRequest({
        request: postRequest(output),
        env,
        params: {},
      });
      const firstBody = (await first.json()) as { sid: string };

      const second = await onRequest({
        request: postRequest(output),
        env,
        params: {},
      });
      const secondBody = (await second.json()) as { sid: string };

      expect(secondBody.sid).toBe(firstBody.sid);
    });
  });

  describe("POST failure modes", () => {
    it("returns 400 on malformed JSON", async () => {
      const response = await onRequest({
        request: postRequest("not-json"),
        env: makeEnv(),
        params: {},
      });
      expect(response.status).toBe(400);
    });

    it("returns 400 when the shared snapshot contract rejects the payload", async () => {
      const response = await onRequest({
        request: postRequest({ profile: "treasury" }),
        env: makeEnv(),
        params: {},
      });
      expect(response.status).toBe(400);
    });

    it("returns 400 when the shared structural guard rejects the payload", async () => {
      const response = await onRequest({
        request: postRequest(JSON.stringify(JSON.parse(`{"__proto__":{"polluted":true}}`))),
        env: makeEnv(),
        params: {},
      });
      expect(response.status).toBe(400);
    });

    it("returns 413 when Content-Length advertises an oversized payload", async () => {
      const response = await onRequest({
        request: postRequest(buildSelectorSnapshotOutput(), {
          "Content-Type": "application/json",
          Origin: "https://pharos.watch",
          "Content-Length": String(200 * 1024),
        }),
        env: makeEnv(),
        params: {},
      });
      expect(response.status).toBe(413);
    });

    it("returns 413 when the body itself exceeds the size cap", async () => {
      const response = await onRequest({
        request: postRequest({
          ...buildSelectorSnapshotOutput(),
          oversizedTestPadding: "x".repeat(101 * 1024),
        }),
        env: makeEnv(),
        params: {},
      });
      expect(response.status).toBe(413);
    });

    it("cancels a chunked request body as soon as it crosses the byte cap", async () => {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(101 * 1024));
        },
        cancel,
      });
      const request = new Request("https://pharos.watch/selector-snapshot", {
        method: "POST",
        body,
        headers: POST_HEADERS,
        duplex: "half",
      } as RequestInit & { duplex: "half" });

      const response = await onRequest({ request, env: makeEnv(), params: {} });

      expect(response.status).toBe(413);
      expect(cancel).toHaveBeenCalled();
    });

    it("enforces the streaming cap when Content-Length falsely claims a small body", async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(101 * 1024));
        },
      });
      const request = new Request("https://pharos.watch/selector-snapshot", {
        method: "POST",
        body,
        headers: { ...POST_HEADERS, "Content-Length": "1" },
        duplex: "half",
      } as RequestInit & { duplex: "half" });

      const response = await onRequest({ request, env: makeEnv(), params: {} });
      expect(response.status).toBe(413);
    });

    it("returns 413 when a multibyte body exceeds the byte cap", async () => {
      const response = await onRequest({
        request: postRequest({
          ...buildSelectorSnapshotOutput(),
          oversizedTestPadding: "🙂".repeat(30 * 1024),
        }),
        env: makeEnv(),
        params: {},
      });
      expect(response.status).toBe(413);
    });

    it("returns 500 when the KV binding is missing", async () => {
      const response = await onRequest({
        request: postRequest(buildSelectorSnapshotOutput()),
        env: makeEnv({ SELECTOR_SNAPSHOTS: undefined }),
        params: {},
      });
      expect(response.status).toBe(500);
    });

    it("fails closed when the dedicated IP HMAC pepper is missing", async () => {
      const response = await onRequest({
        request: postRequest(buildSelectorSnapshotOutput()),
        env: makeEnv({ SELECTOR_SNAPSHOT_IP_HASH_SECRET: "" }),
        params: {},
      });
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: "Snapshot write limiter is not configured" });
    });

    it("returns 503 when the D1 quota binding is missing for identified clients", async () => {
      const response = await onRequest({
        request: postRequest(buildSelectorSnapshotOutput(), {
          ...POST_HEADERS,
          "CF-Connecting-IP": "203.0.113.88",
        }),
        env: makeEnv({ DB: undefined }),
        params: {},
      });
      expect(response.status).toBe(503);
    });

    it("returns 503 when the D1 quota reservation fails", async () => {
      const db = makeD1();
      db.__setRunHandler(() => {
        throw new Error("d1 unavailable");
      });
      const response = await onRequest({
        request: postRequest(buildSelectorSnapshotOutput(), {
          ...POST_HEADERS,
          "CF-Connecting-IP": "203.0.113.89",
        }),
        env: makeEnv({ DB: db }),
        params: {},
      });
      expect(response.status).toBe(503);
    });

    it("returns 503 instead of storing caller output when canonical recomputation fails", async () => {
      recomputeVerifiedSelectorSnapshotMock.mockRejectedValueOnce(new Error("canonical source unavailable"));
      const env = makeEnv();
      const response = await onRequest({
        request: postRequest(buildSelectorSnapshotOutput({ datasetHash: "f".repeat(64) })),
        env,
        params: {},
      });

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: "Canonical selector data temporarily unavailable" });
      expect((env.SELECTOR_SNAPSHOTS as TestKVNamespace).__getStore().size).toBe(0);
    });

    it("returns 503 when the KV write fails", async () => {
      const kv = makeKV();
      kv.__setWriteHandler(() => {
        throw new Error("kv unavailable");
      });
      const response = await onRequest({
        request: postRequest(buildSelectorSnapshotOutput()),
        env: makeEnv({ SELECTOR_SNAPSHOTS: kv }),
        params: {},
      });
      expect(response.status).toBe(503);
    });

    it("returns 405 when POST is sent with a sid segment", async () => {
      const response = await onRequest({
        request: new Request("https://pharos.watch/selector-snapshot/00112233445566778899aabbccddeeff", {
          method: "POST",
          body: JSON.stringify(buildSelectorSnapshotOutput()),
          headers: POST_HEADERS,
        }),
        env: makeEnv(),
        params: { path: "00112233445566778899aabbccddeeff" },
      });
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET");
    });
  });

  describe("GET storage", () => {
    it("returns the normalized stored payload", async () => {
      const env = makeEnv();
      const post = await onRequest({
        request: postRequest(buildSelectorSnapshotOutput()),
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
      expect(body.provenance).toBe("pharos-verified");
      expect(body.snapshotSchemaVersion).toBe(3);
    });

    it("strips debug from a legacy stored value before replay", async () => {
      const env = makeEnv();
      const kv = env.SELECTOR_SNAPSHOTS as TestKVNamespace;
      const legacy = {
        ...buildSelectorSnapshotOutput(),
        debug: { allSurvivors: [buildSnapshotRecommendation()] },
      };
      const sid = computeSelectorSnapshotSid(legacy);
      kv.__getStore().set(`s:${sid}`, JSON.stringify(legacy));

      const get = await onRequest({
        request: new Request(`https://pharos.watch/selector-snapshot/${sid}`, {
          headers: { Origin: "https://pharos.watch" },
        }),
        env,
        params: { path: sid },
      });
      expect(get.status).toBe(200);
      const body = (await get.json()) as Record<string, unknown>;
      expect(body.debug).toBeUndefined();
    });

    it("strips prose from legacy stored snapshots before replay", async () => {
      const env = makeEnv();
      const legacyShape = buildSelectorSnapshotOutput({
        recommended: [buildSnapshotRecommendation({ whyText: "Legacy prose", watchText: "Legacy watch" })],
        lowerRanked: [
          {
            id: "usdt-tether",
            symbol: "USDT",
            name: "Tether USD",
            slot: "A",
            reasonKey: "weak-liquidity",
            failedComponent: "liquidity",
            hypotheticalScore: 70,
            verdictText: "Legacy verdict",
            teachingText: "Legacy teaching",
          },
        ],
      });
      const sid = computeSelectorSnapshotSid(legacyShape);
      const kv = env.SELECTOR_SNAPSHOTS as TestKVNamespace;
      kv.__getStore().set(`s:${sid}`, JSON.stringify(legacyShape));

      const get = await onRequest({
        request: new Request(`https://pharos.watch/selector-snapshot/${sid}`, {
          headers: { Origin: "https://pharos.watch" },
        }),
        env,
        params: { path: sid },
      });
      expect(get.status).toBe(200);
      const body = (await get.json()) as Record<string, unknown>;
      const recommended = body.recommended as Array<Record<string, unknown>>;
      const lowerRanked = body.lowerRanked as Array<Record<string, unknown>>;
      expect(recommended[0]?.whyText).toBeUndefined();
      expect(recommended[0]?.watchText).toBeUndefined();
      expect(lowerRanked[0]?.verdictText).toBeUndefined();
      expect(lowerRanked[0]?.teachingText).toBeUndefined();
    });

    it("replays a recognized legacy sid with explicit unverified provenance", async () => {
      const env = makeEnv();
      const kv = env.SELECTOR_SNAPSHOTS as TestKVNamespace;
      const output = buildSelectorSnapshotOutput({
        engineVersion: "selector-v1.9",
        methodologyVersions: {
          ...(buildSelectorSnapshotOutput().methodologyVersions as Record<string, unknown>),
          exclusionFilters: "selector-v1.9",
        },
      });
      const sid = computeSelectorSnapshotSid(output);
      kv.__getStore().set(`s:${sid}`, JSON.stringify(output));

      const get = await onRequest({
        request: new Request(`https://pharos.watch/selector-snapshot/${sid}`, {
          headers: { Origin: "https://pharos.watch" },
        }),
        env,
        params: { path: sid },
      });

      expect(get.status).toBe(200);
      const body = (await get.json()) as Record<string, unknown>;
      expect(body.provenance).toBe("client-unverified");
      expect(body.snapshotSchemaVersion).toBe(2);
      expect(kv.__getPutCalls().at(-1)?.options?.metadata).toEqual({ extended: true, legacySid: sid });
    });

    it("downgrades a forged verified payload when KV metadata does not attest it", async () => {
      const env = makeEnv();
      const kv = env.SELECTOR_SNAPSHOTS as TestKVNamespace;
      const forged = buildVerifiedSnapshot();
      const sid = computeSelectorSnapshotSid(forged);
      kv.__getStore().set(`s:${sid}`, JSON.stringify(forged));

      const response = await onRequest({
        request: new Request(`https://pharos.watch/selector-snapshot/${sid}`, {
          headers: { Origin: "https://pharos.watch" },
        }),
        env,
        params: { path: sid },
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        provenance: "client-unverified",
        snapshotSchemaVersion: 2,
      });
    });
  });

  describe("retention", () => {
    it("writes with the unread TTL and extends to full retention on first read only", async () => {
      const env = makeEnv();
      const kv = env.SELECTOR_SNAPSHOTS as TestKVNamespace;
      const post = await onRequest({
        request: postRequest(buildSelectorSnapshotOutput()),
        env,
        params: {},
      });
      const { sid } = (await post.json()) as { sid: string };

      expect(kv.__getPutCalls()).toHaveLength(1);
      expect(kv.__getPutCalls()[0]).toMatchObject({
        key: `s:${sid}`,
        options: { expirationTtl: SELECTOR_SNAPSHOT_UNREAD_TTL_SECONDS },
      });

      const getOnce = await onRequest({
        request: new Request(`https://pharos.watch/selector-snapshot/${sid}`, {
          headers: { Origin: "https://pharos.watch" },
        }),
        env,
        params: { path: sid },
      });
      expect(getOnce.status).toBe(200);
      expect(kv.__getPutCalls()).toHaveLength(2);
      expect(kv.__getPutCalls()[1]).toMatchObject({
        key: `s:${sid}`,
        options: {
          expirationTtl: SELECTOR_SNAPSHOT_TTL_SECONDS,
          metadata: { extended: true, trust: SELECTOR_SNAPSHOT_VERIFICATION_KIND },
        },
      });

      const getTwice = await onRequest({
        request: new Request(`https://pharos.watch/selector-snapshot/${sid}`, {
          headers: { Origin: "https://pharos.watch" },
        }),
        env,
        params: { path: sid },
      });
      expect(getTwice.status).toBe(200);
      expect(kv.__getPutCalls()).toHaveLength(2);
    });

    it("returns 503 instead of claiming success when the retention extension fails", async () => {
      const env = makeEnv();
      const kv = env.SELECTOR_SNAPSHOTS as TestKVNamespace;
      const post = await onRequest({
        request: postRequest(buildSelectorSnapshotOutput()),
        env,
        params: {},
      });
      const { sid } = (await post.json()) as { sid: string };
      kv.__setWriteHandler(() => {
        throw new Error("extension unavailable");
      });

      const get = await onRequest({
        request: new Request(`https://pharos.watch/selector-snapshot/${sid}`, {
          headers: { Origin: "https://pharos.watch" },
        }),
        env,
        params: { path: sid },
      });

      expect(get.status).toBe(503);
      await expect(get.json()).resolves.toEqual({ error: "Snapshot retention could not be extended" });
    });
  });

  describe("POST rate limiting", () => {
    it("returns 429 after exceeding the per-IP write budget", async () => {
      const env = makeEnv();
      const output = buildSelectorSnapshotOutput();
      const limitedHeaders = {
        ...POST_HEADERS,
        "CF-Connecting-IP": "203.0.113.77",
      };

      let lastStatus = 0;
      for (let i = 0; i < 10; i++) {
        const response = await onRequest({
          request: postRequest(output, limitedHeaders),
          env,
          params: {},
        });
        lastStatus = response.status;
      }
      expect(lastStatus).toBe(200);

      const throttled = await onRequest({
        request: postRequest(output, limitedHeaders),
        env,
        params: {},
      });
      expect(throttled.status).toBe(429);
      expect(throttled.headers.get("Retry-After")).toBe("60");

      const otherIp = await onRequest({
        request: postRequest(output, { ...POST_HEADERS, "CF-Connecting-IP": "203.0.113.78" }),
        env,
        params: {},
      });
      expect(otherIp.status).toBe(200);
    });
  });

  it("persists a per-IP daily quota across isolate rate-limit windows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-19T00:00:00Z"));
    const db = makeD1();
    const env = makeEnv({ DB: db });
    const output = buildSelectorSnapshotOutput();
    const headers = {
      ...POST_HEADERS,
      "CF-Connecting-IP": "203.0.113.90",
    };

    for (let i = 0; i < 100; i++) {
      vi.setSystemTime(new Date(Date.UTC(2026, 5, 19, 0, i + 1, 0)));
      const response = await onRequest({
        request: postRequest({ ...output, datasetHash: i.toString(16).padStart(64, "0") }, headers),
        env,
        params: {},
      });
      expect(response.status).toBe(200);
    }

    vi.setSystemTime(new Date(Date.UTC(2026, 5, 19, 1, 50, 0)));
    const throttled = await onRequest({
      request: postRequest({ ...output, datasetHash: "f".repeat(64) }, headers),
      env,
      params: {},
    });
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("Retry-After")).toBe("86400");
    expect([...(env.DB as TestD1Database).__getQuotaRows().values()]).toEqual([100]);
  });

  it("stores only a peppered HMAC-derived IP quota key", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db, SELECTOR_SNAPSHOT_IP_HASH_SECRET: "pepper-one-which-is-long-enough-for-tests" });
    const ip = "203.0.113.201";
    const response = await onRequest({
      request: postRequest(buildSelectorSnapshotOutput(), {
        ...POST_HEADERS,
        "CF-Connecting-IP": ip,
      }),
      env,
      params: {},
    });
    expect(response.status).toBe(200);

    const [storedKey] = [...db.__getQuotaRows().keys()];
    const unsalted = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
    const unsaltedPrefix = Array.from(new Uint8Array(unsalted).slice(0, 16), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    expect(storedKey).not.toContain(ip);
    expect(storedKey).not.toContain(unsaltedPrefix);
    expect(storedKey).toMatch(/^\d{4}-\d{2}-\d{2}:[0-9a-f]{32}$/);
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

    it("returns 502 when the stored KV payload does not match the requested sid", async () => {
      const env = makeEnv();
      const post = await onRequest({
        request: postRequest(buildSelectorSnapshotOutput()),
        env,
        params: {},
      });
      const { sid } = (await post.json()) as { sid: string };
      const kv = env.SELECTOR_SNAPSHOTS as TestKVNamespace;
      kv.__getStore().set(`s:${sid}`, JSON.stringify(buildVerifiedSnapshot({ datasetHash: "b".repeat(64) })));

      const response = await onRequest({
        request: new Request(`https://pharos.watch/selector-snapshot/${sid}`, {
          headers: { Origin: "https://pharos.watch" },
        }),
        env,
        params: { path: sid },
      });
      expect(response.status).toBe(502);
    });

    it("returns 502 when a KV-attested verified score is tampered", async () => {
      const env = makeEnv();
      const post = await onRequest({
        request: postRequest(buildSelectorSnapshotOutput()),
        env,
        params: {},
      });
      const { sid } = (await post.json()) as { sid: string };
      const kv = env.SELECTOR_SNAPSHOTS as TestKVNamespace;
      const stored = JSON.parse(kv.__getStore().get(`s:${sid}`) ?? "{}") as {
        recommended: Array<{ score: number }>;
      };
      stored.recommended[0]!.score = 100;
      kv.__getStore().set(`s:${sid}`, JSON.stringify(stored));

      const response = await onRequest({
        request: new Request(`https://pharos.watch/selector-snapshot/${sid}`, {
          headers: { Origin: "https://pharos.watch" },
        }),
        env,
        params: { path: sid },
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
