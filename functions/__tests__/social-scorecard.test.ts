import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { API_ORIGIN, SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { hashClientIp } from "@shared/lib/client-ip-hash";
import { SOCIAL_SCORECARD_DAILY_QUOTA } from "@shared/lib/pages-storage";
import { sha256Hex } from "@shared/lib/sha256";
import { SOCIAL_SCORECARD_OBJECT_PREFIX, type SocialPreviewBucket } from "@shared/lib/social-preview-storage";
import {
  SOCIAL_SCORECARD_METADATA_HEADER,
  encodeSocialScorecardMetadata, openSocialScorecard, sealSocialScorecard,
} from "@shared/lib/social-scorecard";
import {
  mintSiteSessionToken,
  SITE_SESSION_COOKIE_NAME,
  SITE_SESSION_HEADER,
  SITE_SESSION_HINT_HEADER,
} from "@shared/lib/site-session-token";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { makeScorecardImageFixture, makeScorecardMetadataFixture } from "@shared/test-utils/social-scorecard";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { onRequest as onCreateRequest } from "../_site-data/scorecard";
import { onRequest } from "../share/scorecard/[[path]]";

let ipCounter = 0;
const now = 1_795_000_000;
const quotaDate = new Date(now * 1000).toISOString().slice(0, 10);
const ipSecret = "scorecard-test-secret";
const sessionKey = "scorecard-session-key";
const databases = createLatestSchemaFixtureTracker();

function makeBucket() {
  const store = new Map<string, string>();
  const writes: string[] = [];
  const get = vi.fn<SocialPreviewBucket["get"]>(async (key) => {
    const value = store.get(key);
    return value === undefined ? null : {
      text: async () => value,
      arrayBuffer: async () => new TextEncoder().encode(value).buffer,
    };
  });
  const put = vi.fn<SocialPreviewBucket["put"]>(async (key, value, options) => {
    expect(options.onlyIf).toEqual({ etagDoesNotMatch: "*" });
    if (store.has(key)) return null;
    if (typeof value !== "string") throw new Error("Expected sealed JSON");
    store.set(key, value);
    writes.push(key);
    return { etag: "r2-storage-etag" };
  });
  return { bucket: { get, put }, store, writes };
}

function setup() {
  const { bucket, store, writes } = makeBucket();
  const { sqlite } = databases.open();
  let quotaRunHandler: ((sql: string) => void) | null = null;
  const db = createSqliteD1(sqlite, { onRun: (sql) => quotaRunHandler?.(sql) });
  const metadata = makeScorecardMetadataFixture(now);
  const image = makeScorecardImageFixture();
  const fetchMock = mockFetch([{
    match: `${API_ORIGIN}${API_PATHS.ogScorecard("usdc-circle")}`,
    respond: () => new Response(image, { headers: { "Content-Type": "image/png", [SOCIAL_SCORECARD_METADATA_HEADER]: encodeSocialScorecardMetadata(metadata) } }),
  }], { requireMatch: true, strictUrl: true });
  const env = { SOCIAL_PREVIEWS: bucket, DB: db, SELECTOR_SNAPSHOT_IP_HASH_SECRET: ipSecret };
  const create = (overrides: Partial<Parameters<typeof onCreateRequest>[0]["env"]>, headers: Record<string, string> = {}) => onCreateRequest({
    request: new Request(`${SITE_ORIGIN}/_site-data/scorecard`, {
      method: "POST", headers: { Origin: SITE_ORIGIN, "CF-Connecting-IP": `192.0.2.${++ipCounter}`, "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ stablecoinId: "usdc-circle" }),
    }), env: { ...env, ...overrides },
  });
  const post = (body: unknown = { stablecoinId: "usdc-circle" }, headers: Record<string, string> = {}) => onCreateRequest({
    request: new Request(`${SITE_ORIGIN}/_site-data/scorecard`, {
      method: "POST", headers: { Origin: SITE_ORIGIN, "CF-Connecting-IP": `192.0.2.${++ipCounter}`, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
    }), env,
  });
  const get = (id: string, imageOnly = false, method = "GET", headers: Record<string, string> = {}) => onRequest({
    request: new Request(`${SITE_ORIGIN}/share/scorecard/${id}${imageOnly ? ".png" : "/"}`, { method, headers }),
    env, params: { path: imageOnly ? `${id}.png` : [id] },
  });
  const quotaRows = () => sqlite.prepare("SELECT quota_date, quota_key, count FROM social_scorecard_daily_quota ORDER BY quota_date, quota_key").all();
  const seedQuota = (key: string, count: number, date = quotaDate) => sqlite.prepare(
    "INSERT INTO social_scorecard_daily_quota (quota_date, quota_key, count, first_seen_at, last_seen_at) VALUES (?, ?, ?, 0, 0)",
  ).run(date, key, count);
  return { bucket, store, writes, sqlite, db, quotaRows, seedQuota, metadata, image, fetchMock, env, post, create, get, setQuotaRunHandler: (handler: typeof quotaRunHandler) => { quotaRunHandler = handler; } };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now * 1000); });
afterEach(() => { databases.closeAll(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("retained dated scorecard Pages routes", () => {
  it("creates immediately readable HTML and PNG from one permanent sealed R2 object", async () => {
    const { post, get, bucket, store, writes, metadata, image, fetchMock } = setup();
    const response = await post();
    expect(response.status).toBe(201);
    const result = await response.json() as { url: string; imageUrl: string };
    const id = result.url.split("/").filter(Boolean).pop()!;
    const key = `${SOCIAL_SCORECARD_OBJECT_PREFIX}${id}`;
    expect(result.imageUrl).toBe(`${SITE_ORIGIN}/share/scorecard/${id}.png`);
    expect(writes).toEqual([key]);
    expect(bucket.put).toHaveBeenCalledWith(key, expect.any(String), {
      onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "application/json" },
    });
    expect(openSocialScorecard(id, store.get(key)!)).toEqual({ metadata, image });
    const htmlResponse = await get(id);
    const html = await htmlResponse.text();
    expect(htmlResponse.headers.get("X-Robots-Tag")).toBe("noindex, follow");
    expect(htmlResponse.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
    expect(htmlResponse.headers.get("ETag")).toBe(`"${sha256Hex(html)}"`);
    expect(htmlResponse.headers.get("ETag")).not.toBe(`"${id}"`);
    expect(html).toContain(`<link rel="canonical" href="${result.url}">`);
    expect(html).toContain(`<meta property="og:url" content="${result.url}">`);
    expect(html).toContain(result.imageUrl);
    expect(html).toContain('href="https://pharos.watch/stablecoin/usdc-circle/"');
    expect(html).toContain("published grade A, Safety Score 82/100");
    expect(html).toContain("Methodology v10.37");
    expect(html).toContain(metadata.publication.publicationGenerationId);
    const png = await get(id, true);
    expect(png.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(png.headers.get("ETag")).toBe(`"${metadata.imageSha256}"`);
    expect(new Uint8Array(await png.arrayBuffer())).toEqual(image);
    expect(await (await get(id, false, "HEAD")).text()).toBe("");
    // Public reads need no quota DB or live generation, even years later.
    vi.setSystemTime((now + 366 * 86400) * 1000);
    expect((await get(id)).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await post()).status).toBe(503);
  });

  it("revalidates each actual representation for GET and HEAD with weak/list/wildcard validators", async () => {
    const { post, get, metadata, env } = setup();
    const { url } = await (await post()).json() as { url: string };
    const id = url.split("/").filter(Boolean).pop()!;
    for (const imageOnly of [false, true]) {
      const original = await get(id, imageOnly);
      const etag = original.headers.get("ETag")!;
      for (const method of ["GET", "HEAD"]) {
        for (const validator of [etag, `W/${etag}`, `"other,opaque", W/${etag}`, `, , W/${etag},`, "*"]) {
          const cached = await get(id, imageOnly, method, { "If-None-Match": validator });
          expect(cached.status).toBe(304);
          expect(cached.headers.get("ETag")).toBe(etag);
          expect(cached.headers.get("Cache-Control")).toBe(original.headers.get("Cache-Control"));
          expect(await cached.text()).toBe("");
        }
        expect((await get(id, imageOnly, method, { "If-None-Match": '"different"' })).status).toBe(200);
        expect((await get(id, imageOnly, method, { "If-None-Match": `invalid ${etag}` })).status).toBe(200);
      }
    }
    expect((await get(id, false, "GET", { "If-None-Match": `"${metadata.imageSha256}"` })).status).toBe(200);
    const publicRead = await onRequest({
      request: new Request(url), env: { ...env, DB: undefined }, params: { path: id },
    });
    expect(publicRead.status).toBe(200);
  });

  it("reuses existing records without quota and conditionally resolves concurrent creation without overwriting", async () => {
    const { post, bucket, writes, store, quotaRows } = setup();
    const responses = await Promise.all([post(), post()]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(await responses[0].json()).toEqual(await responses[1].json());
    expect(store.size).toBe(1);
    expect(writes).toHaveLength(1);
    const attempts = bucket.put.mock.calls.length;
    const charged = quotaRows();
    expect((await post()).status).toBe(201);
    expect(bucket.put).toHaveBeenCalledTimes(attempts);
    expect(quotaRows()).toEqual(charged);
  });

  it("never replaces a corrupt existing object or trusts an unverified conditional winner", async () => {
    const { post, store, bucket, metadata, image } = setup();
    const sealed = sealSocialScorecard(metadata, image);
    const key = `${SOCIAL_SCORECARD_OBJECT_PREFIX}${sealed.id}`;
    store.set(key, "corrupt");
    expect((await post()).status).toBe(503);
    expect(bucket.put).not.toHaveBeenCalled();
    store.clear();
    bucket.put.mockImplementationOnce(async () => { store.set(key, "corrupt-winner"); return null; });
    expect((await post()).status).toBe(503);
    expect(store.get(key)).toBe("corrupt-winner");
    store.clear();
    bucket.put.mockResolvedValueOnce({ etag: "ack-without-object" });
    expect((await post()).status).toBe(503);
  });

  it("supports public overview editions without a fictitious grade", async () => {
    const { metadata, image, env, get } = setup();
    metadata.subject = { kind: "overview", id: "safety-scores", ratedCount: 8, notRatedCount: 1, unavailableCount: 1, totalCount: 10, averageScore: 72.5 };
    mockFetch([{ match: `${API_ORIGIN}${API_PATHS.ogScorecard("safety-scores")}`, respond: () => new Response(image, { headers: { "Content-Type": "image/png", [SOCIAL_SCORECARD_METADATA_HEADER]: encodeSocialScorecardMetadata(metadata) } }) }], { requireMatch: true });
    const created = await onCreateRequest({ request: new Request(`${SITE_ORIGIN}/_site-data/scorecard`, { method: "POST", headers: { Origin: SITE_ORIGIN, "CF-Connecting-IP": `192.0.2.${++ipCounter}`, "Content-Type": "application/json" }, body: JSON.stringify({ stablecoinId: "safety-scores" }) }), env });
    expect(created.status).toBe(201);
    const { url } = await created.json() as { url: string };
    const html = await (await get(url.split("/").filter(Boolean).pop()!)).text();
    expect(html).toContain("8 rated of 10 stablecoins; 1 not rated; 1 unavailable");
    expect(html).toContain('href="https://pharos.watch/safety-scores/"');
    expect(html).not.toContain("published grade");
  });

  it("uses only the canonical public OG lane, including over a service binding", async () => {
    const { image, metadata, env, fetchMock } = setup();
    const binding = { fetch: vi.fn(async (request: Request) => {
      expect(request.url).toBe(`${API_ORIGIN}${API_PATHS.ogScorecard("usdc-circle")}`);
      expect(request.headers.has("Cookie")).toBe(false);
      expect(request.headers.has(SITE_SESSION_HEADER)).toBe(false);
      expect(request.headers.has("X-Pharos-Site-Proxy-Secret")).toBe(false);
      expect(request.headers.has("Authorization")).toBe(false);
      return new Response(image, { headers: { "Content-Type": "image/png", [SOCIAL_SCORECARD_METADATA_HEADER]: encodeSocialScorecardMetadata(metadata) } });
    }) };
    const response = await onCreateRequest({ request: new Request(`${SITE_ORIGIN}/_site-data/scorecard`, { method: "POST", headers: { Origin: SITE_ORIGIN, "CF-Connecting-IP": `192.0.2.${++ipCounter}`, "Content-Type": "application/json", Cookie: "private=user", [SITE_SESSION_HEADER]: "forged" }, body: JSON.stringify({ stablecoinId: "usdc-circle" }) }), env: { ...env, SITE_API: binding } });
    expect(response.status).toBe(201);
    expect(binding.fetch).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exposes creation only as scoped POST and removes the unscoped write entrypoint", async () => {
    const { env, quotaRows, fetchMock } = setup();
    for (const mode of [undefined, "enforce"]) {
      const legacy = await onRequest({
        request: new Request(`${SITE_ORIGIN}/share/scorecard`, { method: "POST", headers: { Origin: SITE_ORIGIN } }),
        env: { ...env, SITE_SESSION_ENFORCEMENT: mode }, params: {},
      });
      expect(legacy.status).toBe(405);
      expect(legacy.headers.get("Allow")).toBe("GET, HEAD");
    }
    for (const method of ["GET", "HEAD", "PUT"]) {
      const response = await onCreateRequest({
        request: new Request(`${SITE_ORIGIN}/_site-data/scorecard`, { method, headers: { Origin: SITE_ORIGIN } }),
        env,
      });
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("POST");
      expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    }
    expect(quotaRows()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires the existing signed session before quotas or capture when enforcement is enabled", async () => {
    const { create, quotaRows, bucket, fetchMock } = setup();
    const env = { SITE_SESSION_ENFORCEMENT: "enforce", SITE_SESSION_SIGNING_KEY: sessionKey };
    const valid = await mintSiteSessionToken({ key: sessionKey, kind: "browser", nowSec: now });
    const expired = await mintSiteSessionToken({ key: sessionKey, kind: "browser", nowSec: now - 604_900 });
    const forged = await mintSiteSessionToken({ key: "not-the-signing-key", kind: "browser", nowSec: now });
    const rejectedHeaders: Record<string, string>[] = [
      {},
      { Cookie: `${SITE_SESSION_COOKIE_NAME}=malformed` },
      { Cookie: `${SITE_SESSION_COOKIE_NAME}=${expired}` },
      { Cookie: `${SITE_SESSION_COOKIE_NAME}=${forged}` },
      { [SITE_SESSION_HEADER]: valid },
    ];
    for (const headers of rejectedHeaders) {
      const response = await create(env, headers);
      expect(response.status).toBe(401);
      expect(response.headers.get(SITE_SESSION_HINT_HEADER)).toBe("required");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect((await create({ ...env, SITE_SESSION_SIGNING_KEY: " " })).status).toBe(503);
    expect(quotaRows()).toEqual([]);
    expect(bucket.get).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["browser", "automation"] as const)("accepts existing %s sessions and signing-key rotation", async (kind) => {
    const { create, fetchMock } = setup();
    const token = await mintSiteSessionToken({ key: sessionKey, kind, nowSec: now });
    const response = await create({
      SITE_SESSION_ENFORCEMENT: "enforce", SITE_SESSION_SIGNING_KEY: "new-signing-key",
      SITE_SESSION_SIGNING_KEY_PREVIOUS: sessionKey,
    }, { Cookie: `${SITE_SESSION_COOKIE_NAME}=${token}` });
    expect(response.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([undefined, "observe", "true"])("keeps the default-off creation contract for mode %s", async (mode) => {
    const { create } = setup();
    expect((await create({ SITE_SESSION_ENFORCEMENT: mode }, { Cookie: `${SITE_SESSION_COOKIE_NAME}=invalid` })).status).toBe(201);
  });

  it("serves anonymous retained GET/HEAD without live or session configuration under enforcement", async () => {
    const { create, env, fetchMock } = setup();
    const { url } = await (await create({})).json() as { url: string };
    const id = url.split("/").filter(Boolean).pop()!;
    fetchMock.mockClear();
    vi.setSystemTime((now + 366 * 86400) * 1000);
    for (const method of ["GET", "HEAD"]) {
      for (const imageOnly of [false, true]) {
        const response = await onRequest({
          request: new Request(imageOnly ? url.slice(0, -1) + ".png" : url, { method }),
          env: { SOCIAL_PREVIEWS: env.SOCIAL_PREVIEWS, SITE_SESSION_ENFORCEMENT: "enforce" },
          params: { path: imageOnly ? `${id}.png` : id },
        });
        expect(response.status).toBe(200);
        if (method === "HEAD") expect(await response.text()).toBe("");
      }
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed on binding errors and redirects without a public-HTTP fallback", async () => {
    const { create, fetchMock, bucket } = setup();
    const binding = { fetch: vi.fn().mockRejectedValueOnce(new Error("binding unavailable"))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: "https://evil.test/image.png" } })) };
    expect((await create({ SITE_API: binding })).status).toBe(503);
    expect((await create({ SITE_API: binding })).status).toBe(503);
    expect(binding.fetch).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it("rechecks source clocks after reading the entire upstream PNG", async () => {
    const { create, metadata, image, bucket } = setup();
    const binding = { fetch: vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(image);
        vi.setSystemTime((metadata.asOfSec + metadata.freshnessBudgetSec) * 1000);
        controller.close();
      },
    }), { headers: { "Content-Type": "image/png", [SOCIAL_SCORECARD_METADATA_HEADER]: encodeSocialScorecardMetadata(metadata) } })) };
    expect((await create({ SITE_API: binding })).status).toBe(503);
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it("rejects untrusted origins, private inputs, oversized bodies and missing limiter/store/DB config", async () => {
    const { post, env, quotaRows, fetchMock } = setup();
    expect((await post(undefined, { Origin: "https://evil.test" })).status).toBe(404);
    for (const field of [{ score: 100 }, { grade: "A+" }, { url: "https://evil.test" }]) expect((await post({ stablecoinId: "usdc-circle", ...field })).status).toBe(400);
    expect((await post({ stablecoinId: "x".repeat(300) })).status).toBe(413);
    expect((await post(undefined, { "CF-Connecting-IP": "" })).status).toBe(503);
    for (const invalidEnv of [{ ...env, SOCIAL_PREVIEWS: undefined }, { ...env, DB: undefined }, { ...env, SELECTOR_SNAPSHOT_IP_HASH_SECRET: "" }]) {
      const response = await onCreateRequest({ request: new Request(`${SITE_ORIGIN}/_site-data/scorecard`, { method: "POST", headers: { Origin: SITE_ORIGIN, "CF-Connecting-IP": "192.0.2.253" }, body: "{}" }), env: invalidEnv });
      expect(response.status).toBe(503);
    }
    expect(quotaRows()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("enforces durable 20/IP UTC-day creation limits, never on re-shares, and does not consume global capacity for refused IPs", async () => {
    const { post, fetchMock, quotaRows, metadata } = setup();
    const ip = "192.0.2.254";
    const hash = await hashClientIp(`social-scorecard:${ip}`, ipSecret);
    const edition = (offset: number) => { metadata.asOfSec = now - 120 - offset; };
    for (let i = 0; i < 20; i++) {
      edition(i);
      expect((await post(undefined, { "CF-Connecting-IP": ip })).status).toBe(201);
    }
    edition(20);
    const rejected = await post(undefined, { "CF-Connecting-IP": ip });
    expect(rejected.status).toBe(429);
    expect(Number(rejected.headers.get("Retry-After"))).toBe(Math.ceil((Date.parse(`${quotaDate}T00:00:00Z`) + 86_400_000 - now * 1000) / 1000));
    const charged = [
      { quota_date: quotaDate, quota_key: hash, count: 20 },
      { quota_date: quotaDate, quota_key: "global", count: 20 },
    ].sort((a, b) => a.quota_key.localeCompare(b.quota_key));
    expect(quotaRows()).toEqual(charged);
    // Dedupe precedes reservation: an exhausted IP can still re-share a sealed edition.
    edition(7);
    expect((await post(undefined, { "CF-Connecting-IP": ip })).status).toBe(201);
    expect(quotaRows()).toEqual(charged);
    expect(fetchMock).toHaveBeenCalledTimes(22);
  });

  it("atomically bounds concurrent global attempts without creating refused client rows", async () => {
    const { post, seedQuota, quotaRows, fetchMock } = setup();
    seedQuota(SOCIAL_SCORECARD_DAILY_QUOTA.globalKey, 1_999);
    const responses = await Promise.all([post(), post()]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 429]);
    expect(quotaRows().filter((row) => row.quota_key !== "global").map((row) => row.count)).toEqual([1]);
    expect(quotaRows().find((row) => row.quota_key === "global")?.count).toBe(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refunds the first reservation when an IP refuses, using the original UTC day across midnight", async () => {
    const { post, seedQuota, quotaRows, db, fetchMock } = setup();
    const ip = "192.0.2.254";
    const hash = await hashClientIp(`social-scorecard:${ip}`, ipSecret);
    seedQuota(hash, 20);
    const batch = db.batch.bind(db);
    vi.spyOn(db, "batch").mockImplementationOnce(async (statements) => {
      const result = await batch(statements);
      vi.setSystemTime(new Date(`${quotaDate}T23:59:59Z`).getTime() + 1_000);
      return result;
    });
    expect((await post(undefined, { "CF-Connecting-IP": ip })).status).toBe(429);
    expect(quotaRows().find((row) => row.quota_key === "global")?.count).toBe(0);
    expect(quotaRows().find((row) => row.quota_key === hash)?.count).toBe(20);
    expect(quotaRows().every((row) => row.quota_date === quotaDate)).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("prunes expired counters in bounded indexed batches and starts a fresh UTC-day bucket", async () => {
    const { post, seedQuota, quotaRows, metadata } = setup();
    const expired = new Date((now - 3 * 86400) * 1000).toISOString().slice(0, 10);
    const retained = new Date((now - 2 * 86400) * 1000).toISOString().slice(0, 10);
    for (let index = 0; index < 300; index++) seedQuota(`expired-${index}`, 1, expired);
    seedQuota("keep", 1, retained);
    expect((await post()).status).toBe(201);
    expect(quotaRows().filter((row) => row.quota_date === expired)).toHaveLength(44);
    metadata.asOfSec -= 1;
    expect((await post()).status).toBe(201);
    expect(quotaRows().some((row) => row.quota_date === expired)).toBe(false);
    expect(quotaRows().some((row) => row.quota_date === retained)).toBe(true);
    vi.setSystemTime((now + 86400) * 1000);
    metadata.asOfSec += 86400;
    metadata.publishedAtSec += 86400;
    expect((await post()).status).toBe(201);
    expect(quotaRows().filter((row) => row.quota_key === "global").map((row) => row.count)).toEqual([2, 1]);
  });

  it("fails closed on quota transactions and rolls back the first counter if the second write fails", async () => {
    const { post, quotaRows, fetchMock, setQuotaRunHandler } = setup();
    setQuotaRunHandler((sql) => {
      if (sql === SOCIAL_SCORECARD_DAILY_QUOTA.consumeIpSql) throw new Error("D1 unavailable");
    });
    expect((await post()).status).toBe(503);
    expect(quotaRows()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
    setQuotaRunHandler(null);
    expect((await post()).status).toBe(201);
  });

  it.each(["upstream", "metadata", "identity", "pixels", "stale", "observation", "future", "revision"])("reserves nothing on %s capture faults and retains no partial edition", async (fault) => {
    const { post, metadata, image, bucket, quotaRows } = setup();
    if (fault === "identity") metadata.subject.id = "usdt-tether";
    if (fault === "pixels") image[32] ^= 1;
    if (fault === "stale") metadata.publishedAtSec = now - metadata.freshnessBudgetSec;
    if (fault === "stale") metadata.asOfSec = metadata.publishedAtSec - 1;
    if (fault === "observation") metadata.asOfSec = now - metadata.freshnessBudgetSec;
    if (fault === "future") metadata.publishedAtSec = now + 1;
    if (fault === "revision") metadata.rendererRevision = "scorecard-2";
    mockFetch([{ match: API_PATHS.ogScorecard("usdc-circle"), respond: () => new Response(image, { status: fault === "upstream" ? 503 : 200, headers: { "Content-Type": "image/png", ...(fault === "metadata" ? {} : { [SOCIAL_SCORECARD_METADATA_HEADER]: encodeSocialScorecardMetadata(metadata) }) } }) }], { requireMatch: true });
    expect((await post()).status).toBe(503);
    expect(bucket.put).not.toHaveBeenCalled();
    expect(quotaRows()).toEqual([]);
  });

  it("reads old renderer editions but never substitutes live data for missing or corrupt retained identities", async () => {
    const { store, get, metadata, image, fetchMock } = setup();
    metadata.rendererRevision = "scorecard-2";
    const sealed = sealSocialScorecard(metadata, image);
    expect((await get(sealed.id, false, "GET", { "If-None-Match": "*" })).status).toBe(404);
    store.set(`${SOCIAL_SCORECARD_OBJECT_PREFIX}${sealed.id}`, JSON.stringify(sealed.record));
    expect((await get(sealed.id, true)).status).toBe(200);
    store.set(`${SOCIAL_SCORECARD_OBJECT_PREFIX}${sealed.id}`, JSON.stringify({ ...sealed.record, imageBase64: btoa("corrupt") }));
    expect((await get(sealed.id, true, "HEAD", { "If-None-Match": "*" })).status).toBe(502);
    expect((await get("f".repeat(64))).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed on R2 read/write outages while retaining accepted attempt charges", async () => {
    const { post, bucket, get, quotaRows } = setup();
    bucket.get.mockRejectedValueOnce(new Error("R2 unavailable"));
    expect((await post()).status).toBe(503);
    bucket.get.mockRejectedValueOnce(new Error("R2 unavailable"));
    expect((await get("a".repeat(64))).status).toBe(503);
    bucket.put.mockRejectedValueOnce(new Error("R2 unavailable"));
    expect((await post()).status).toBe(503);
    // Only the write outage follows a reservation; the dedupe read failed before one.
    expect(quotaRows().find((row) => row.quota_key === "global")?.count).toBe(1);
  });
});
