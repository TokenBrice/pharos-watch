import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KVNamespace, KVNamespaceGetOptions } from "@cloudflare/workers-types";
import {
  SELECTOR_SNAPSHOT_TTL_SECONDS,
  SELECTOR_SNAPSHOT_UNREAD_TTL_SECONDS,
} from "../../shared/lib/selector/snapshot";
import {
  buildSelectorSnapshotOutput,
  buildSnapshotRecommendation,
} from "../../shared/lib/selector/__tests__/snapshot-fixture";
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
    it("stores the payload and returns a 32-hex sid", async () => {
      const env = makeEnv();
      const response = await onRequest({
        request: postRequest(buildSelectorSnapshotOutput()),
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
    it("returns the stored payload byte-for-byte", async () => {
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
    });

    it("strips debug from a legacy stored value before replay", async () => {
      const env = makeEnv();
      const post = await onRequest({
        request: postRequest(buildSelectorSnapshotOutput()),
        env,
        params: {},
      });
      const { sid } = (await post.json()) as { sid: string };
      const kv = env.SELECTOR_SNAPSHOTS as TestKVNamespace;
      kv.__getStore().set(
        `s:${sid}`,
        JSON.stringify({
          ...buildSelectorSnapshotOutput(),
          debug: { allSurvivors: [buildSnapshotRecommendation()] },
        }),
      );

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
        options: { expirationTtl: SELECTOR_SNAPSHOT_TTL_SECONDS, metadata: { extended: true } },
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
      kv.__getStore().set(`s:${sid}`, JSON.stringify(buildSelectorSnapshotOutput({ datasetHash: "different-hash" })));

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
