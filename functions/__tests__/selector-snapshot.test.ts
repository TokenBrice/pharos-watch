import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, createHmac } from "node:crypto";
import type { D1Database, KVNamespace } from "@shared/types/cloudflare-runtime";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { makeKV, type TestKVNamespace } from "./helpers/mock-kv";
import { makePagesProxyContext } from "./helpers/pages-context";
import {
  SELECTOR_SNAPSHOT_TTL_SECONDS,
  SELECTOR_SNAPSHOT_UNREAD_TTL_SECONDS,
  computeSelectorSnapshotSid,
  createVerifiedSelectorSnapshot,
  validateSelectorSnapshot,
} from "@shared/lib/selector/snapshot";
import { SELECTOR_SNAPSHOT_VERIFICATION_KIND } from "@shared/lib/selector/types";
import {
  buildSelectorSnapshotOutput,
  buildSnapshotRecommendation,
} from "@shared/lib/selector/__tests__/snapshot-fixture";

const { recomputeVerifiedSelectorSnapshotMock } = vi.hoisted(() => ({
  recomputeVerifiedSelectorSnapshotMock: vi.fn(),
}));

vi.mock("../lib/selector-canonical-snapshot", () => ({
  recomputeVerifiedSelectorSnapshot: recomputeVerifiedSelectorSnapshotMock,
}));

import { onRequest } from "../selector-snapshot/[[path]].ts";

const databases = createLatestSchemaFixtureTracker();

function makeD1() {
  const { sqlite } = databases.open();
  let runHandler: (() => void) | null = null;
  const db = createSqliteD1(sqlite, { onRun: () => runHandler?.() });
  return Object.assign(db, {
    __getQuotaRows: () => new Map(
      sqlite.prepare("SELECT quota_date, ip_hash, count FROM selector_snapshot_daily_quota")
        .all().map((row) => [`${row.quota_date}:${row.ip_hash}`, Number(row.count)] as const),
    ),
    __setRunHandler: (handler: () => void) => { runHandler = handler; },
    __seedQuota: (date: string, hash: string, count: number) => {
      sqlite.prepare(
        "INSERT INTO selector_snapshot_daily_quota (quota_date, ip_hash, count, first_seen_at, last_seen_at) VALUES (?, ?, ?, 0, 0)",
      ).run(date, hash, count);
    },
  });
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

/** Pages context bag for the `/selector-snapshot/[[path]]` catch-all. */
function snapshotContext(request: Request, env: ReturnType<typeof makeEnv> = makeEnv()) {
  return makePagesProxyContext({ request, env, mountPath: "/selector-snapshot" });
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

function getRequest(sid: string): Request {
  return new Request(`https://pharos.watch/selector-snapshot/${sid}`, {
    headers: { Origin: "https://pharos.watch" },
  });
}

function buildVerifiedSnapshot(overrides: Record<string, unknown> = {}) {
  const validation = validateSelectorSnapshot(buildSelectorSnapshotOutput(overrides));
  if (!validation.ok) throw new Error(`Invalid verified snapshot fixture: ${validation.error}`);
  return createVerifiedSelectorSnapshot(validation.snapshot);
}

function buildProseSnapshot(prose: string) {
  return buildSelectorSnapshotOutput({
    recommended: [buildSnapshotRecommendation({ whyText: prose, watchText: prose })],
    lowerRanked: [{
      id: "usdt-tether",
      symbol: "USDT",
      name: "Tether USD",
      slot: "A",
      reasonKey: "weak-liquidity",
      failedComponent: "liquidity",
      hypotheticalScore: 70,
      verdictText: prose,
      teachingText: prose,
    }],
  });
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
    databases.closeAll();
  });

  describe("origin gating", () => {
    it("rejects POST without Origin/Referer", async () => {
      const response = await onRequest(
        snapshotContext(new Request("https://pharos.watch/selector-snapshot", {
          method: "POST",
          body: JSON.stringify(buildSelectorSnapshotOutput()),
          headers: { "Content-Type": "application/json" },
        })),
      );
      expect(response.status).toBe(404);
    });

    it("rejects GET without Origin/Referer", async () => {
      const response = await onRequest(
        snapshotContext(new Request("https://pharos.watch/selector-snapshot/00112233445566778899aabbccddeeff")),
      );
      expect(response.status).toBe(404);
    });

    it("rejects POST from foreign origin", async () => {
      const response = await onRequest(
        snapshotContext(postRequest(buildSelectorSnapshotOutput(), {
          "Content-Type": "application/json",
          Origin: "https://evil.example.com",
        })),
      );
      expect(response.status).toBe(404);
    });

    it("accepts POST from allowlisted ops origin", async () => {
      const response = await onRequest(
        snapshotContext(postRequest(buildSelectorSnapshotOutput(), {
          "Content-Type": "application/json",
          Origin: "https://ops.pharos.watch",
        })),
      );
      expect(response.status).toBe(200);
    });

    it("accepts requests when Origin is missing but Referer is allowlisted", async () => {
      const response = await onRequest(
        snapshotContext(postRequest(buildSelectorSnapshotOutput(), {
          "Content-Type": "application/json",
          Referer: "https://pharos.watch/screener/picker/",
        })),
      );
      expect(response.status).toBe(200);
    });
  });

  describe("POST storage", () => {
    it("stores a server-recomputed verified payload and returns its binding", async () => {
      const env = makeEnv();
      const response = await onRequest(snapshotContext(postRequest(buildSelectorSnapshotOutput()), env));
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

      const forgedResponse = await onRequest(snapshotContext(postRequest(forged), env));
      const inputOnlyResponse = await onRequest(snapshotContext(postRequest({ input: forged.input }), env));
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

      const response = await onRequest(snapshotContext(postRequest({ input: canonical.input }), env));

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

      const debug = await onRequest(snapshotContext(postRequest(withDebug), env));
      const debugBody = (await debug.json()) as { sid: string };
      const kv = env.SELECTOR_SNAPSHOTS as TestKVNamespace;
      const stored = JSON.parse(kv.__getStore().get(`s:${debugBody.sid}`) ?? "{}") as Record<string, unknown>;
      expect(stored.debug).toBeUndefined();

      const plain = await onRequest(snapshotContext(postRequest(output), env));
      const plainBody = (await plain.json()) as { sid: string };
      expect(debugBody.sid).toBe(plainBody.sid);
    });

    it("strips caller-authored prose before storing snapshots", async () => {
      const env = makeEnv();
      const output = buildProseSnapshot("Attacker-authored prose.");

      const response = await onRequest(snapshotContext(postRequest(output), env));
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

      const first = await onRequest(snapshotContext(postRequest(output), env));
      const firstBody = (await first.json()) as { sid: string };

      const second = await onRequest(snapshotContext(postRequest(output), env));
      const secondBody = (await second.json()) as { sid: string };

      expect(secondBody.sid).toBe(firstBody.sid);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const kv = env.SELECTOR_SNAPSHOTS as TestKVNamespace;
      expect(kv.__getPutCalls()).toHaveLength(1);
      expect((await onRequest(snapshotContext(getRequest(firstBody.sid), env))).status).toBe(200);
      const retained = await onRequest(snapshotContext(postRequest(output), env));
      expect(retained.status).toBe(200);
      await expect(retained.json()).resolves.toMatchObject({ sid: firstBody.sid });
      expect(kv.__getPutCalls()).toHaveLength(2);
      expect(kv.__getPutCalls()[1]?.options?.expirationTtl).toBe(SELECTOR_SNAPSHOT_TTL_SECONDS);
    });

    it.each(["corrupt JSON", "wrong SID", "lookup failure"])("overwrites trusted %s with canonical content", async (failure) => {
      const kv = makeKV();
      const canonical = buildVerifiedSnapshot();
      const sid = computeSelectorSnapshotSid(canonical);
      await kv.put(`s:${sid}`, failure === "corrupt JSON" ? "{" : JSON.stringify(
        buildVerifiedSnapshot({ datasetHash: "b".repeat(64) }),
      ), { metadata: { trust: SELECTOR_SNAPSHOT_VERIFICATION_KIND } });
      if (failure === "lookup failure") kv.__setReadHandler(() => { throw new Error("lookup failed"); });
      const response = await onRequest(snapshotContext(postRequest({ input: canonical.input }), makeEnv({ SELECTOR_SNAPSHOTS: kv })));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ sid });
      expect(JSON.parse(kv.__getStore().get(`s:${sid}`)!)).toEqual(canonical);
      expect(kv.__getPutCalls()).toHaveLength(2);
      expect(kv.__getPutCalls()[1]?.options?.metadata).toEqual({ trust: SELECTOR_SNAPSHOT_VERIFICATION_KIND });
    });
  });

  describe("POST failure modes", () => {
    it.each(["stream error", "invalid UTF-8"])("rejects %s before reservation or storage", async (failure) => {
      const db = makeD1();
      const env = makeEnv({ DB: db });
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (failure === "stream error") controller.error(new Error("body unavailable"));
          else {
            controller.enqueue(new Uint8Array([0xc3, 0x28]));
            controller.close();
          }
        },
      });
      const response = await onRequest(snapshotContext(new Request("https://pharos.watch/selector-snapshot", {
        method: "POST",
        headers: { ...POST_HEADERS, "CF-Connecting-IP": failure === "stream error" ? "203.0.113.210" : "203.0.113.211" },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" }), env));
      expect(response.status).toBe(400);
      expect(db.__getQuotaRows().size).toBe(0);
      expect(recomputeVerifiedSelectorSnapshotMock).not.toHaveBeenCalled();
      expect((env.SELECTOR_SNAPSHOTS as TestKVNamespace).__getPutCalls()).toEqual([]);
    });

    it("returns 400 on malformed JSON", async () => {
      const response = await onRequest(snapshotContext(postRequest("not-json")));
      expect(response.status).toBe(400);
    });

    it("returns 400 when the shared snapshot contract rejects the payload", async () => {
      const response = await onRequest(snapshotContext(postRequest({ profile: "treasury" })));
      expect(response.status).toBe(400);
    });

    it("returns 400 when the shared structural guard rejects the payload", async () => {
      const response = await onRequest(
        snapshotContext(postRequest(JSON.stringify(JSON.parse(`{"__proto__":{"polluted":true}}`)))),
      );
      expect(response.status).toBe(400);
    });

    it("returns 413 when Content-Length advertises an oversized payload", async () => {
      const response = await onRequest(
        snapshotContext(postRequest(buildSelectorSnapshotOutput(), {
          "Content-Type": "application/json",
          Origin: "https://pharos.watch",
          "Content-Length": String(200 * 1024),
        })),
      );
      expect(response.status).toBe(413);
    });

    it("returns 413 when the body itself exceeds the size cap", async () => {
      const response = await onRequest(
        snapshotContext(postRequest({
          ...buildSelectorSnapshotOutput(),
          oversizedTestPadding: "x".repeat(101 * 1024),
        })),
      );
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

      const response = await onRequest(snapshotContext(request));

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

      const response = await onRequest(snapshotContext(request));
      expect(response.status).toBe(413);
    });

    it("returns 413 when a multibyte body exceeds the byte cap", async () => {
      const response = await onRequest(
        snapshotContext(postRequest({
          ...buildSelectorSnapshotOutput(),
          oversizedTestPadding: "🙂".repeat(30 * 1024),
        })),
      );
      expect(response.status).toBe(413);
    });

    it("returns 500 when the KV binding is missing", async () => {
      const response = await onRequest(
        snapshotContext(postRequest(buildSelectorSnapshotOutput()), makeEnv({ SELECTOR_SNAPSHOTS: undefined })),
      );
      expect(response.status).toBe(500);
    });

    it("fails closed when the dedicated IP HMAC pepper is missing", async () => {
      const response = await onRequest(
        snapshotContext(postRequest(buildSelectorSnapshotOutput()), makeEnv({ SELECTOR_SNAPSHOT_IP_HASH_SECRET: "" })),
      );
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: "Snapshot write limiter is not configured" });
    });

    it("returns 503 when the D1 quota binding is missing for identified clients", async () => {
      const response = await onRequest(
        snapshotContext(postRequest(buildSelectorSnapshotOutput(), {
          ...POST_HEADERS,
          "CF-Connecting-IP": "203.0.113.88",
        }), makeEnv({ DB: undefined })),
      );
      expect(response.status).toBe(503);
    });

    it("returns 503 when the D1 quota reservation fails", async () => {
      const db = makeD1();
      db.__setRunHandler(() => {
        throw new Error("d1 unavailable");
      });
      const response = await onRequest(
        snapshotContext(postRequest(buildSelectorSnapshotOutput(), {
          ...POST_HEADERS,
          "CF-Connecting-IP": "203.0.113.89",
        }), makeEnv({ DB: db })),
      );
      expect(response.status).toBe(503);
    });

    it("returns 503 instead of storing caller output when canonical recomputation fails", async () => {
      recomputeVerifiedSelectorSnapshotMock.mockRejectedValueOnce(new Error("canonical source unavailable"));
      const env = makeEnv();
      const response = await onRequest(
        snapshotContext(postRequest(buildSelectorSnapshotOutput({ datasetHash: "f".repeat(64) })), env),
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: "Canonical selector data temporarily unavailable" });
      expect((env.SELECTOR_SNAPSHOTS as TestKVNamespace).__getStore().size).toBe(0);
    });

    it("returns 503 when the KV write fails", async () => {
      const kv = makeKV();
      kv.__setWriteHandler(() => {
        throw new Error("kv unavailable");
      });
      const response = await onRequest(
        snapshotContext(postRequest(buildSelectorSnapshotOutput()), makeEnv({ SELECTOR_SNAPSHOTS: kv })),
      );
      expect(response.status).toBe(503);
    });

    it("returns 405 when POST is sent with a sid segment", async () => {
      const response = await onRequest(
        snapshotContext(new Request("https://pharos.watch/selector-snapshot/00112233445566778899aabbccddeeff", {
          method: "POST",
          body: JSON.stringify(buildSelectorSnapshotOutput()),
          headers: POST_HEADERS,
        })),
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET");
    });
  });

  describe("GET storage", () => {
    it("returns the normalized stored payload", async () => {
      const env = makeEnv();
      const post = await onRequest(snapshotContext(postRequest(buildSelectorSnapshotOutput()), env));
      const { sid } = (await post.json()) as { sid: string };

      const get = await onRequest(
        snapshotContext(getRequest(sid), env),
      );
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

      const get = await onRequest(
        snapshotContext(getRequest(sid), env),
      );
      expect(get.status).toBe(200);
      const body = (await get.json()) as Record<string, unknown>;
      expect(body.debug).toBeUndefined();
    });

    it("strips prose from legacy stored snapshots before replay", async () => {
      const env = makeEnv();
      const legacyShape = buildProseSnapshot("Legacy prose.");
      const sid = computeSelectorSnapshotSid(legacyShape);
      const kv = env.SELECTOR_SNAPSHOTS as TestKVNamespace;
      kv.__getStore().set(`s:${sid}`, JSON.stringify(legacyShape));

      const get = await onRequest(
        snapshotContext(getRequest(sid), env),
      );
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

      const get = await onRequest(
        snapshotContext(getRequest(sid), env),
      );

      expect(get.status).toBe(200);
      const body = (await get.json()) as Record<string, unknown>;
      expect(body.provenance).toBe("client-unverified");
      expect(body.snapshotSchemaVersion).toBe(2);
      expect(kv.__getPutCalls().at(-1)?.options?.metadata).toEqual({ extended: true, legacySid: sid });
      const replay = await onRequest(snapshotContext(getRequest(sid), env));
      expect(replay.status).toBe(200);
      await expect(replay.json()).resolves.toEqual(body);
      expect(kv.__getPutCalls()).toHaveLength(1);
    });

    it("downgrades a forged verified payload when KV metadata does not attest it", async () => {
      const env = makeEnv();
      const kv = env.SELECTOR_SNAPSHOTS as TestKVNamespace;
      const forged = buildVerifiedSnapshot();
      const sid = computeSelectorSnapshotSid(forged);
      kv.__getStore().set(`s:${sid}`, JSON.stringify(forged));

      const response = await onRequest(
        snapshotContext(getRequest(sid), env),
      );

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
      const post = await onRequest(snapshotContext(postRequest(buildSelectorSnapshotOutput()), env));
      const { sid } = (await post.json()) as { sid: string };

      expect(kv.__getPutCalls()).toHaveLength(1);
      expect(kv.__getPutCalls()[0]).toMatchObject({
        key: `s:${sid}`,
        options: { expirationTtl: SELECTOR_SNAPSHOT_UNREAD_TTL_SECONDS },
      });

      const getOnce = await onRequest(
        snapshotContext(getRequest(sid), env),
      );
      expect(getOnce.status).toBe(200);
      expect(kv.__getPutCalls()).toHaveLength(2);
      expect(kv.__getPutCalls()[1]).toMatchObject({
        key: `s:${sid}`,
        options: {
          expirationTtl: SELECTOR_SNAPSHOT_TTL_SECONDS,
          metadata: { extended: true, trust: SELECTOR_SNAPSHOT_VERIFICATION_KIND },
        },
      });

      const getTwice = await onRequest(
        snapshotContext(getRequest(sid), env),
      );
      expect(getTwice.status).toBe(200);
      expect(kv.__getPutCalls()).toHaveLength(2);
    });

    it("returns 503 instead of claiming success when the retention extension fails", async () => {
      const env = makeEnv();
      const kv = env.SELECTOR_SNAPSHOTS as TestKVNamespace;
      const post = await onRequest(snapshotContext(postRequest(buildSelectorSnapshotOutput()), env));
      const { sid } = (await post.json()) as { sid: string };
      kv.__setWriteHandler(() => {
        throw new Error("extension unavailable");
      });

      const get = await onRequest(
        snapshotContext(getRequest(sid), env),
      );

      expect(get.status).toBe(503);
      await expect(get.json()).resolves.toEqual({ error: "Snapshot retention could not be extended" });
    });
  });

  describe("POST rate limiting", () => {
    it("returns 429 after exceeding the per-IP write budget", async () => {
      vi.useFakeTimers();
      const start = new Date("2026-06-20T12:00:00Z").getTime();
      vi.setSystemTime(start);
      const env = makeEnv();
      const output = buildSelectorSnapshotOutput();
      const limitedHeaders = {
        ...POST_HEADERS,
        "CF-Connecting-IP": "203.0.113.77",
      };

      for (let i = 0; i < 10; i++) {
        const response = await onRequest(snapshotContext(postRequest(output, limitedHeaders), env));
        expect(response.status).toBe(200);
      }

      const throttled = await onRequest(snapshotContext(postRequest(output, limitedHeaders), env));
      expect(throttled.status).toBe(429);
      expect(throttled.headers.get("Retry-After")).toBe("60");
      vi.setSystemTime(start + 59_999);
      expect((await onRequest(snapshotContext(postRequest(output, limitedHeaders), env))).status).toBe(429);
      vi.setSystemTime(start + 60_000);
      expect((await onRequest(snapshotContext(postRequest(output, limitedHeaders), env))).status).toBe(200);

      const otherIp = await onRequest(
        snapshotContext(postRequest(output, { ...POST_HEADERS, "CF-Connecting-IP": "203.0.113.78" }), env),
      );
      expect(otherIp.status).toBe(200);
    });
  });

  it("persists the daily boundary across minute windows and resets at UTC midnight", async () => {
    vi.useFakeTimers();
    const db = makeD1();
    const env = makeEnv({ DB: db });
    const ip = "203.0.113.90";
    const hash = createHmac("sha256", env.SELECTOR_SNAPSHOT_IP_HASH_SECRET!).update(ip).digest("hex").slice(0, 32);
    db.__seedQuota("2026-06-19", hash, 98);
    const headers = { ...POST_HEADERS, "CF-Connecting-IP": ip };
    const send = () => onRequest(snapshotContext(postRequest(buildSelectorSnapshotOutput(), headers), env));
    vi.setSystemTime(new Date("2026-06-19T23:56:00Z"));
    expect((await send()).status).toBe(200);
    expect(db.__getQuotaRows().get(`2026-06-19:${hash}`)).toBe(99);
    vi.setSystemTime(new Date("2026-06-19T23:57:00Z"));
    expect((await send()).status).toBe(200);
    expect(db.__getQuotaRows().get(`2026-06-19:${hash}`)).toBe(100);
    vi.setSystemTime(new Date("2026-06-19T23:58:00Z"));
    const throttled = await send();
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("Retry-After")).toBe("86400");
    expect(db.__getQuotaRows().get(`2026-06-19:${hash}`)).toBe(100);
    vi.setSystemTime(new Date("2026-06-20T00:00:00Z"));
    expect((await send()).status).toBe(200);
    expect([...db.__getQuotaRows()]).toEqual([
      [`2026-06-19:${hash}`, 100],
      [`2026-06-20:${hash}`, 1],
    ]);
  });

  it("uses deterministic, IP-separated and configured-pepper HMAC quota identities", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-21T00:00:00Z"));
    const db = makeD1();
    const firstPepper = "pepper-one-which-is-long-enough-for-tests";
    const secondPepper = "pepper-two-which-is-long-enough-for-tests";
    const firstIp = "203.0.113.201";
    const secondIp = "203.0.113.202";
    for (const [ip, pepper] of [[firstIp, firstPepper], [secondIp, firstPepper], [firstIp, secondPepper], [firstIp, firstPepper]]) {
      const env = makeEnv({ DB: db, SELECTOR_SNAPSHOT_IP_HASH_SECRET: pepper });
      const response = await onRequest(snapshotContext(postRequest(buildSelectorSnapshotOutput(), {
        ...POST_HEADERS, "CF-Connecting-IP": ip,
      }), env));
      expect(response.status).toBe(200);
    }
    const key = (ip: string, pepper: string) =>
      `2026-06-21:${createHmac("sha256", pepper).update(ip).digest("hex").slice(0, 32)}`;
    expect(db.__getQuotaRows()).toEqual(new Map([
      [key(firstIp, firstPepper), 2],
      [key(secondIp, firstPepper), 1],
      [key(firstIp, secondPepper), 1],
    ]));
    for (const storedKey of db.__getQuotaRows().keys()) {
      expect(storedKey).not.toContain(firstIp);
      expect(storedKey).not.toContain(secondIp);
      expect(storedKey).not.toContain(createHash("sha256").update(firstIp).digest("hex").slice(0, 32));
      expect(storedKey).toMatch(/^\d{4}-\d{2}-\d{2}:[0-9a-f]{32}$/);
    }
  });

  describe("GET failure modes", () => {
    it("returns 404 for an unknown sid", async () => {
      const env = makeEnv();
      const response = await onRequest(
        snapshotContext(getRequest("00112233445566778899aabbccddeeff"), env),
      );
      expect(response.status).toBe(404);
    });

    it("returns 404 when the sid is not 32 hex chars", async () => {
      const response = await onRequest(
        snapshotContext(getRequest("not-a-sid")),
      );
      expect(response.status).toBe(404);
    });

    it.each([
      ["corrupt JSON", "{not valid json}"],
      ["wrong shape", JSON.stringify({ wrong: "shape" })],
    ])("returns 502 for stored %s", async (_label, stored) => {
      const kv = makeKV();
      kv.__setReadHandler(() => stored);
      const response = await onRequest(
        snapshotContext(getRequest("00112233445566778899aabbccddeeff"), makeEnv({ SELECTOR_SNAPSHOTS: kv })),
      );
      expect(response.status).toBe(502);
    });


    it("returns 502 when the stored KV payload does not match the requested sid", async () => {
      const env = makeEnv();
      const post = await onRequest(snapshotContext(postRequest(buildSelectorSnapshotOutput()), env));
      const { sid } = (await post.json()) as { sid: string };
      const kv = env.SELECTOR_SNAPSHOTS as TestKVNamespace;
      kv.__getStore().set(`s:${sid}`, JSON.stringify(buildVerifiedSnapshot({ datasetHash: "b".repeat(64) })));

      const response = await onRequest(
        snapshotContext(getRequest(sid), env),
      );
      expect(response.status).toBe(502);
    });

    it("returns 502 when a KV-attested verified score is tampered", async () => {
      const env = makeEnv();
      const post = await onRequest(snapshotContext(postRequest(buildSelectorSnapshotOutput()), env));
      const { sid } = (await post.json()) as { sid: string };
      const kv = env.SELECTOR_SNAPSHOTS as TestKVNamespace;
      const stored = JSON.parse(kv.__getStore().get(`s:${sid}`) ?? "{}") as {
        recommended: Array<{ score: number }>;
      };
      stored.recommended[0]!.score = 100;
      kv.__getStore().set(`s:${sid}`, JSON.stringify(stored));

      const response = await onRequest(
        snapshotContext(getRequest(sid), env),
      );
      expect(response.status).toBe(502);
    });

    it("returns 503 when the KV read throws", async () => {
      const kv = makeKV();
      kv.__setReadHandler(() => {
        throw new Error("kv read failed");
      });
      const response = await onRequest(
        snapshotContext(getRequest("00112233445566778899aabbccddeeff"), makeEnv({ SELECTOR_SNAPSHOTS: kv })),
      );
      expect(response.status).toBe(503);
    });

    it("returns 500 when the KV binding is missing on GET", async () => {
      const response = await onRequest(
        snapshotContext(getRequest("00112233445566778899aabbccddeeff"), makeEnv({ SELECTOR_SNAPSHOTS: undefined })),
      );
      expect(response.status).toBe(500);
    });
  });

  describe("unsupported methods", () => {
    it("returns 405 with Allow on PUT", async () => {
      const response = await onRequest(
        snapshotContext(new Request("https://pharos.watch/selector-snapshot", {
          method: "PUT",
          headers: { Origin: "https://pharos.watch" },
        })),
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET, POST");
    });

    it("returns 405 with Allow on DELETE", async () => {
      const response = await onRequest(
        snapshotContext(new Request("https://pharos.watch/selector-snapshot/00112233445566778899aabbccddeeff", {
          method: "DELETE",
          headers: { Origin: "https://pharos.watch" },
        })),
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET, POST");
    });
  });
});
