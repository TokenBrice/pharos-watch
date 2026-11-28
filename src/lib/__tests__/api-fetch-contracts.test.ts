import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { StablecoinChartResponseSchema } from "@shared/types/supply";
import { StablecoinReservesResponseSchema } from "@shared/types/live-reserves";
import { DdrResponseSchema } from "@shared/types/depeg-resolver";
import { PHAROS_WEB_ACCEPT_MARKER } from "@shared/lib/request-source-marker";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "../request-lifecycle";
import { jsonResponse, mockFetch } from "@shared/test-utils/mock-fetch";
import { mockAbortableFetch, mockJsonOnce } from "@/test-utils/api-fetch";
import {
  apiRequest, apiFetch, apiFetchWithMeta as fetchMeta, ApiFetchError,
  buildRequestUrl, fetchStablecoinReserves as fetchReserves, resolveApiBase, SchemaValidationError,
} from "../api";
import { SAFETY_SCORE_PUBLICATION_AGE_REASON } from "@pharos/contracts/api-meta";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { FRESHNESS_RATIOS } from "@shared/lib/status-thresholds";
import { deriveDataHealth, isPublicWarning } from "../data-health";
import { DATA_HEALTH_PRESETS } from "../data-health-config";
import { PUBLIC_API_ACCEPT } from "../api-request-policy";

const OK = z.object({ ok: z.boolean() });
const PH = "pharos.watch", OPS = "ops.pharos.watch", STABLECOINS = "/api/stablecoins", SITE = "/_site-data";
const M200 = { updatedAt: 200, ageSeconds: 20, status: "fresh" } as const;
const DDR_WARN = "Forecast from Pharos historical data. Not investment advice or a credit rating.";
const stubHost = (hostname = PH) => vi.stubGlobal("window", { location: { hostname } });
const utc = (hms: string) => Date.parse(`2026-06-23T${hms}.000Z`) / 1000;
const setClock = (iso = "2026-06-23T10:05:00.000Z") => vi.setSystemTime(new Date(iso));
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const spyFetch = () => vi.spyOn(globalThis, "fetch");
const okWith = (headers: Record<string, string>) => mockJsonOnce({ ok: true }, 200, headers);
const abortErr = (msg: string) => new DOMException(msg, "AbortError");
const reserveBody = (ov: Record<string, unknown> = {}) => ({
  stablecoinId: "iusd-infinifi", mode: "live", reserves: [{ name: "Test Farm", pct: 100, risk: "low" }],
  estimated: false, provenance: { evidenceClass: "independent", sourceModel: "dynamic-mix", scoringEligible: true }, ...ov,
});

describe("api contract validation policy", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("throws SchemaValidationError on strict endpoint schema mismatch", async () => {
    mockJsonOnce({ ok: true });
    await expect(apiFetch(STABLECOINS, z.object({ peggedAssets: z.array(z.object({ id: z.string() })) }))).rejects.toBeInstanceOf(SchemaValidationError);
  });

  it("returns raw payloads without schema and keeps permissive behavior only in explicit warn mode", async () => {
    const body = { ok: true, count: 2 };
    mockJsonOnce(body);
    await expect(apiFetch("/api/custom")).resolves.toEqual(body);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = { something: "unexpected" };
    mockJsonOnce(raw);
    expect(await apiFetch("/api/daily-digest", z.object({ digest: z.string() }), undefined, "warn")).toEqual(raw);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("throws on strict endpoint mismatch in apiFetchWithMeta", async () => {
    mockJsonOnce({ _meta: { updatedAt: 100, ageSeconds: 10, status: "fresh" }, wrong: true });
    await expect(fetchMeta(STABLECOINS, z.object({ peggedAssets: z.array(z.unknown()) }))).rejects.toBeInstanceOf(SchemaValidationError);
  });

  it("field-compares a current Worker freshness envelope and drops malformed dependency metadata", async () => {
    const _meta = {
      ...M200, status: "degraded", assessedAt: 220, freshBudgetSec: 1800, degradedBudgetSec: 3600, warning: null,
      dependencies: { reportCards: { updatedAt: 180, ageSeconds: 40, status: "fresh", reason: null } },
    };
    mockJsonOnce({ _meta, summary: null, coins: [] });
    const full = await fetchMeta("/api/peg-summary", z.object({ summary: z.null(), coins: z.array(z.unknown()) }));
    expect([full.data, full.meta]).toEqual([{ summary: null, coins: [] }, _meta]);

    const price = { updatedAt: null, ageSeconds: null, status: "unavailable", reason: null };
    mockJsonOnce({ _meta: { ...M200, dependencies: { bad: { status: "offline", ageSeconds: 50 }, price } }, ok: true });
    expect((await fetchMeta("/api/chains", OK, undefined, "warn")).meta).toEqual({ ...M200, dependencies: { price } });
  });

  it("validates meta-aware response schemas and preserves endpoint-owned _meta without a schema", async () => {
    const t = 1779723422;
    const ddr = {
      _meta: {
        schemaVersion: 2, dataAsOf: t, modelAsOf: t, computedAt: t, expiresAt: t + 1800,
        snapshotToken: null, snapshotGeneration: null, publicPredictionIds: [], publicPredictionRowHashes: {}, basePayloadHash: null,
        readOverlay: { degradedLockDeferralIncidentKeys: [], closedPendingReviewIncidentKeys: [], suppressedIncidentKeys: [] },
        degraded: false, degradedReason: null, publicWarning: DDR_WARN,
        resolutionRubricVersion: "resolution-rubric-v1", durationModelVersion: "duration-landmark-v1",
        incidentGroupingVersion: "incident-group-v1", supportRulesVersion: "support-rules-v1", lineage: null,
      },
      rows: [],
      methodology: { version: "1.0", versionLabel: "v1.0", currentVersion: "1.0", currentVersionLabel: "v1.0", changelogPath: "/methodology/depeg-resolver-changelog/", asOf: t, isCurrent: true },
    };
    mockJsonOnce(ddr, 200, { "X-Data-Age": "0" });
    const parsed = await fetchMeta("/api/depeg-resolver", DdrResponseSchema);
    expect([parsed.data._meta.computedAt, parsed.data.rows]).toEqual([t, []]);
    expect(parsed.meta).toMatchObject({ ageSeconds: 0, status: "fresh" });

    const minimal = { _meta: { schemaVersion: 2, computedAt: t, degraded: false, degradedReason: null, publicWarning: DDR_WARN }, rows: [], methodology: { currentVersionLabel: "v1.0" } };
    mockJsonOnce(minimal, 200, { "X-Data-Age": "30" });
    const raw = await fetchMeta("/api/depeg-resolver");
    expect(raw.data).toEqual(minimal);
    expect(raw.meta).toMatchObject({ ageSeconds: 30, status: "fresh" });
  });

  it("validates stablecoin chart points and open reserve metadata details", () => {
    const pt = { date: 1771977600, aggregateUniverse: "legacy-provider-all-stablecoins-v1", totalCirculatingUSD: { peggedUSD: 1, peggedEUR: 2 } };
    expect(StablecoinChartResponseSchema.parse([pt])).toEqual([pt]);
    expect(() => StablecoinChartResponseSchema.parse([{ ...pt, date: "1771977600" }])).toThrow();

    const ts = 1_761_235_200;
    const parsed = StablecoinReservesResponseSchema.parse(reserveBody({
      liveAt: ts, source: "infinifi", displayUrl: "https://example.com/reserves", evidenceUrls: ["https://example.com/proof"], displayBadge: { kind: "live", label: "Live" },
      metadata: { freshnessMode: "not-applicable", yieldBasisCollateralPct: 89.7, adapterSpecificField: { retained: true }, details: { nestedAdapterTelemetry: { retained: true } }, redemption: { capacityUsd: 1000, routeStatus: "open", adapterSpecificRedemptionField: "retained" } },
      provenance: { evidenceClass: "independent", sourceModel: "dynamic-mix", freshnessMode: "not-applicable", scoringEligible: true },
      sync: { enabled: true, status: "ok", stale: false, bootstrap: false, lastAttemptedAt: ts, lastSuccessAt: ts },
    }));
    expect([parsed.metadata?.details, parsed.metadata?.adapterSpecificField, parsed.metadata?.redemption?.adapterSpecificRedemptionField])
      .toEqual([{ nestedAdapterTelemetry: { retained: true } }, { retained: true }, "retained"]);
  });

  it.each([
    [PH, "", "https://api.pharos.watch"],
    ["c0e7dcc0.stablecoin-dashboard.pages.dev", "", "https://api.pharos.watch"],
    [PH, "https://custom.example", "https://custom.example"],
  ] as const)("resolves API base for host=%s env=%s", (h, env, expected) => { expect(resolveApiBase(h, env)).toBe(expected); });

  const PUB_HIST = "/api/public-status-history", PULSE = "/api/telegram-pulse", POST = { method: "POST" } as const;
  it.each<[string, string, RequestInit | undefined, string]>([
    [PH, STABLECOINS, undefined, `${SITE}/stablecoins`],
    [PH, `${PUB_HIST}?limit=10`, undefined, `${SITE}/public-status-history?limit=10`],
    [PH, PUB_HIST, undefined, `${SITE}/public-status-history`],
    [PH, PULSE, undefined, `${SITE}/telegram-pulse`],
    [OPS, STABLECOINS, undefined, `${SITE}/stablecoins`],
    [OPS, PUB_HIST, undefined, `${SITE}/public-status-history`],
    [OPS, PULSE, undefined, `${SITE}/telegram-pulse`],
    [PH, "/api/donor-key-claims", POST, "/api/donor-key-claims"],
    [PH, "/api/feedback", POST, "/api/feedback"],
    [PH, "/api/og/stablecoin/usdt-tether", undefined, "/api/og/stablecoin/usdt-tether"],
    [PH, "/api/admin/status", undefined, "/api/admin/status"],
  ])("routes %s %s to %s", (host, path, init, expected) => { stubHost(host); expect(buildRequestUrl(path, init)).toBe(expected); });

  it("adds the Pharos browser Accept marker and passes request methods into browser URL lane selection", async () => {
    stubHost();
    const acceptSpy = mockJsonOnce({ ok: true });
    await apiFetch(STABLECOINS, OK, undefined, "warn");
    expect(new Headers((acceptSpy.mock.calls[0]?.[1] as RequestInit | undefined)?.headers).get("Accept")).toContain(PHAROS_WEB_ACCEPT_MARKER);

    vi.restoreAllMocks();
    const postSpy = mockJsonOnce({ ok: true });
    await apiRequest("/api/donor-key-claims", (r) => r.json(), POST);
    expect(postSpy.mock.calls[0]?.[0]).toBe("/api/donor-key-claims");
  });

  it("keeps explicit request options signal precedence over RequestInit", async () => {
    const [initCtl, optsCtl] = [new AbortController(), new AbortController()];
    let sig: AbortSignal | undefined;
    spyFetch().mockImplementation((_i, init) => new Promise<Response>((_res, rej) => {
      sig = init?.signal ?? undefined;
      sig?.addEventListener("abort", () => rej(sig?.reason), { once: true });
    }));
    const pending = apiRequest(STABLECOINS, (r) => r.json(), { signal: initCtl.signal }, { signal: optsCtl.signal, timeoutMs: null });
    initCtl.abort(abortErr("init aborted"));
    expect(sig?.aborted).toBe(false);
    optsCtl.abort(abortErr("options aborted"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "options aborted" });
  });

  it.each([
    ["default", DEFAULT_REQUEST_TIMEOUT_MS, () => apiRequest(STABLECOINS, (r) => r.json())],
    ["override", 250, () => apiFetch(STABLECOINS, undefined, undefined, undefined, { timeoutMs: 250 })],
  ] as const)("applies %s API timeout (%sms)", async (_l, ms, run) => {
    stubHost();
    vi.useFakeTimers();
    mockAbortableFetch(new DOMException("timed out", "TimeoutError"));
    const rej = expect(run()).rejects.toMatchObject({ name: "TimeoutError", message: `API request timed out after ${ms}ms` });
    await advance(ms);
    await rej;
  });

  it("throws ApiFetchError with status/path/bodyText, handles unreadable error bodies, and returns transformed schema output", async () => {
    mockJsonOnce({ error: "nope" }, 503);
    const err = await apiFetch(STABLECOINS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiFetchError);
    expect(err).toMatchObject({ status: 503, path: STABLECOINS, bodyText: '{"error":"nope"}', message: `Failed to fetch ${STABLECOINS}: 503` });

    const unreadable = new ReadableStream<Uint8Array>({ start(c) { c.error(new Error("stream broke")); } });
    spyFetch().mockResolvedValueOnce(new Response(unreadable, { status: 500 }));
    const err2 = await apiFetch(STABLECOINS).catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(ApiFetchError);
    expect(err2).toMatchObject({ status: 500, path: STABLECOINS, bodyText: null });

    mockJsonOnce({ count: 2 });
    expect(await apiFetch("/api/custom", z.object({ count: z.number() }).transform((v) => ({ doubled: v.count * 2 })))).toEqual({ doubled: 4 });
  });

  it("handles fetchStablecoinReserves 404/valid/invalid/abort contracts and default 404 throwing", async () => {
    const stubRes = (id: string, body: unknown, status = 200) => mockFetch([{ match: `/api/stablecoin-reserves/${id}`, body, status }], { requireMatch: true });
    stubRes("usdc-circle", "Not found", 404);
    expect(await fetchReserves("usdc-circle")).toBeNull();

    const body = reserveBody();
    stubRes("iusd-infinifi", body);
    await expect(fetchReserves("iusd-infinifi")).resolves.toEqual(body);

    stubRes("iusd-infinifi", reserveBody({ reserves: [{ name: "Test Farm", pct: "100", risk: "low" }] }));
    await expect(fetchReserves("iusd-infinifi")).rejects.toBeInstanceOf(SchemaValidationError);

    stubRes("test", "Not found", 404);
    await expect(apiFetch("/api/stablecoin-reserves/test")).rejects.toThrow(ApiFetchError);

    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    const ctl = new AbortController();
    const fetchSpy = spyFetch().mockImplementation((_i, init) => new Promise<Response>((resolve, reject) => {
      const sig = init?.signal;
      if (!sig) { resolve(jsonResponse(reserveBody())); return; }
      const onAbort = () => reject(sig.reason ?? abortErr("aborted"));
      if (sig.aborted) { onAbort(); return; }
      sig.addEventListener("abort", onAbort, { once: true });
    }));
    const rej = expect(fetchReserves("iusd-infinifi", { signal: ctl.signal })).rejects.toMatchObject({ name: "AbortError", message: "reserve panel unmounted" });
    ctl.abort(abortErr("reserve panel unmounted"));
    await rej;
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("keeps age metadata unknown for a freshness warning when no age source exists", async () => {
    okWith({ Warning: '110 - "Response is degraded"' });
    const res = await fetchMeta("/api/daily-digest", OK, undefined, "warn");
    expect(res.meta).toEqual({ status: "degraded", warning: '110 - "Response is degraded"' });
    expect(res.meta).not.toHaveProperty("updatedAt");
    expect(res.meta).not.toHaveProperty("ageSeconds");
  });

  it.each(["stale", "unknown"] as const)("preserves %s producer authority from body and header metadata", async (status) => {
    const metadata = { updatedAt: null, ageSeconds: null, status, reason: "producer-history-missing" };
    const warning = '199 - "Producer authority unavailable"';
    for (const bodyMeta of [true, false]) {
      mockJsonOnce({ ok: true, ...(bodyMeta ? { _meta: metadata } : {}) }, 200, {
        "X-Data-Age": "unavailable", "X-Data-Freshness": status, "X-Data-Freshness-Reason": metadata.reason, Warning: warning,
      });
      const res = await fetchMeta("/api/events", OK);
      expect([res.data, res.meta]).toEqual([{ ok: true }, { ...metadata, warning }]);
    }
  });

  const STALE_DEP = { reportCards: { updatedAt: 100, ageSeconds: 120, status: "stale", reason: "stale cache" } };
  const W_DEG = '110 - "Response is degraded (20s old, max 600s)"';
  const W_DRIFT = '199 - "Latest sync-dex-liquidity run shows medium quality drift"';
  it.each<[string, string, Record<string, unknown>, Record<string, string>, Record<string, unknown>, "warn" | undefined]>([
    ["warning-only body metadata with header-derived producer clock", "/api/chains", { _meta: { status: "degraded", warning: "dependency unavailable" }, ok: true }, { Age: "120", "X-Data-Age": "30" }, { updatedAt: utc("10:02:30"), ageSeconds: 30, status: "degraded", warning: "dependency unavailable" }, undefined],
    ["producer status with Warning header and dependencies", "/api/chains", { _meta: { ...M200, dependencies: STALE_DEP }, ok: true }, { Warning: W_DEG }, { ...M200, warning: W_DEG, dependencies: STALE_DEP }, "warn"],
    ["fresh _meta for non-freshness advisory warnings", "/api/dex-liquidity", { _meta: M200, ok: true }, { Warning: W_DRIFT }, { ...M200, warning: W_DRIFT }, "warn"],
    ["X-Data-Age threshold classification left to data health", "/api/dex-liquidity", { ok: true }, { "X-Data-Age": "1122" }, { ageSeconds: 1122, status: "fresh" }, undefined],
    ["edge Age with X-Data-Age as only producer clock", "/api/dex-liquidity", { ok: true }, { Age: "120", "X-Data-Age": "30" }, { updatedAt: utc("10:02:30"), ageSeconds: 30, status: "fresh" }, undefined],
    ["body _meta updatedAt ignoring edge Age", "/api/chains", { _meta: M200, ok: true }, { Age: "120", "X-Data-Age": "30" }, M200, undefined],
    ["server Date header with X-Data-Age", "/api/dex-liquidity", { ok: true }, { Date: "Tue, 23 Jun 2026 10:00:00 GMT", "X-Data-Age": "30" }, { updatedAt: utc("09:59:30"), ageSeconds: 30, status: "fresh" }, undefined],
    ["absolute producer timestamps despite Date, Age and receipt", "/api/stablecoin/usdt-tether", { ok: true }, { Date: "Tue, 23 Jun 2026 10:00:00 GMT", Age: "120", "X-Data-Updated-At": String(utc("08:00:00")), "X-Data-Age": "30", "X-Data-Freshness": "stale", Warning: '110 - "Response is stale"' }, { updatedAt: utc("08:00:00"), ageSeconds: 7500, status: "stale", warning: '110 - "Response is stale"' }, undefined],
  ])("resolves %s", async (_l, path, body, headers, expectedMeta, mode) => {
    setClock();
    mockJsonOnce(body, 200, headers);
    const res = await fetchMeta(path, OK, undefined, mode);
    if ("updatedAt" in expectedMeta) expect(res.meta).toEqual(expectedMeta);
    else expect(res.meta).toMatchObject(expectedMeta);
  });

  it("preserves body-level API warnings in meta-aware fetches", async () => {
    const warning = "Yield history freshness lookup failed; falling back to cache metadata.";
    mockJsonOnce({ current: null, history: [], warning, methodology: { version: "7.45", currentVersion: "7.45", changelogPath: "/methodology/yield-changelog/" } }, 200, { "X-Data-Age": "60" });
    const res = await fetchMeta("/api/yield-history?stablecoin=usdt-tether", z.object({ current: z.null(), history: z.array(z.unknown()), warning: z.string().optional(), methodology: z.object({ version: z.string(), currentVersion: z.string(), changelogPath: z.string() }) }));
    expect(res.data.warning).toContain("freshness lookup failed");
    expect(res.meta).toMatchObject({ ageSeconds: 60, status: "fresh", warning });
  });

  it("reads the Safety Score consumer fail-close as degraded, aged against the Report Cards band", async () => {
    const nowMs = Date.parse("2026-10-22T12:00:00.000Z");
    vi.setSystemTime(new Date(nowMs));
    const health = async (ageSec: number, reason = SAFETY_SCORE_PUBLICATION_AGE_REASON) => {
      okWith({
        "X-Data-Updated-At": String(nowMs / 1000 - ageSec), "X-Data-Age": String(ageSec),
        "X-Data-Freshness": "stale", "X-Data-Freshness-Reason": reason, "X-Safety-Score-Status": "stale",
        Warning: '110 - "Safety Score publication is stale (consumer budget 3600s)"',
      });
      const { meta } = await fetchMeta("/api/report-cards/v9-detail?stablecoin=paxg-paxos", OK);
      return deriveDataHealth({ ...DATA_HEALTH_PRESETS.reportCards, dataUpdatedAt: nowMs, hasData: true, meta }, nowMs);
    };
    const bandSec = FRESHNESS_RATIOS.DEGRADED * API_FRESHNESS_MAX_AGE_SEC.reportCards;
    for (const ageSec of [3_660, 3 * 3_600, bandSec]) { const e = await health(ageSec); expect([e.state, isPublicWarning(e)]).toEqual(["degraded", false]); }
    expect(isPublicWarning(await health(bandSec + 1))).toBe(true);
    expect((await health(3_660, "future-timestamp")).state).toBe("stale");
  });

  it.each(["", "unavailable", "invalid", "-1"])("does not replace invalid absolute producer clock %s with receipt time", async (updatedAt) => {
    okWith({ "X-Data-Updated-At": updatedAt, "X-Data-Age": "0" });
    expect((await fetchMeta("/api/stablecoin/usdt-tether", OK)).meta).toMatchObject({ updatedAt: null, ageSeconds: null, status: "unknown" });
  });
});

describe("browser session gate", () => {
  const EXP_KEY = "pharos-site-session-exp", SESS_URL = `${SITE}/session`;
  beforeEach(() => { vi.useFakeTimers(); setClock("2026-11-16T12:00:00Z"); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });

  const nowSec = () => Math.floor(Date.now() / 1000);
  const okJson = () => jsonResponse({ ok: true });
  const sessionRes = (skew = 0) => new Response(null, { status: 204, headers: { "X-Pharos-Session-Expires": String(nowSec() + 604800 + skew) } });
  const required = () => new Response("session required", { status: 401, headers: { "X-Pharos-Session": "required" } });
  const vis = (visibilityState: "visible" | "hidden") => vi.stubGlobal("document", { visibilityState });
  const calls = (fn: { mock: { calls: unknown[] } }) => fn.mock.calls.length;

  async function setup(flag = "true", siteKey = "test-site-key") {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_PHAROS_SITE_SESSION_CHECK", flag);
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", siteKey);
    vi.stubEnv("NEXT_PUBLIC_API_BASE", "");
    const values = new Map<string, string>();
    const storage = { getItem: vi.fn((k: string) => values.get(k) ?? null), setItem: vi.fn((k: string, v: string) => { values.set(k, v); }), removeItem: vi.fn((k: string) => { values.delete(k); }) };
    vi.stubGlobal("window", { location: { hostname: PH, origin: `https://${PH}`, pathname: "/" }, localStorage: storage });
    const api = await import("../api");
    expect((await import("../site-session-gate")).getSiteSessionGate()).toBeNull();
    const s = await import("../site-session-client");
    const fetchCoins = (opts?: Parameters<typeof api.apiFetch>[4]) => opts ? api.apiFetch(STABLECOINS, undefined, undefined, undefined, opts) : api.apiFetch(STABLECOINS);
    return {
      api, storage, fetchCoins, reg: s.registerSiteSessionChallenge, recover: s.registerSiteSessionRecovery,
      ensure: s.ensureSession, renew: s.renewSiteSessionIfNeeded,
      state: s.getSiteSessionState, valid: s.hasValidSiteSession, paused: s.isSiteSessionPaused,
    };
  }

  it.each([["false", "key"], ["true", ""]])("fetches with flag=%s, key=%s", async (flag, key) => {
    const { api, fetchCoins, reg } = await setup(flag, key), ch = vi.fn();
    reg(ch);
    const spy = spyFetch().mockResolvedValueOnce(required());
    await expect(fetchCoins()).rejects.toBeInstanceOf(api.ApiFetchError);
    expect([calls(spy), spy.mock.calls[0]?.[0], calls(ch)]).toEqual([1, `${SITE}/stablecoins`, 0]);
  });

  it("loads before widget", async () => {
    await setup();
    vi.resetModules();
    const api = await import("../api");
    const spy = spyFetch().mockImplementation(async (u) => u === SESS_URL ? sessionRes() : okJson());
    const pending = api.apiFetch(STABLECOINS);
    const s = await import("../site-session-client");
    s.registerSiteSessionChallenge(async () => "token");
    await expect(pending).resolves.toEqual({ ok: true });
    expect([calls(spy), s.hasValidSiteSession()]).toEqual([2, true]);
  });

  it.each([-600, 600, -605400])("shares local expiry (skew %s)", async (skew) => {
    const { api, storage, fetchCoins, reg, state } = await setup();
    const gtag = vi.fn(), mark = vi.spyOn(performance, "mark");
    window.gtag = gtag;
    let send!: (t: string) => void;
    const solve = vi.fn(() => new Promise<string>((done) => { send = done; }));
    reg(solve);
    const spy = spyFetch().mockImplementation(async (u) => u === SESS_URL ? sessionRes(skew) : okJson());
    const reads = [fetchCoins(), api.apiFetch("/api/daily-digest")];
    await Promise.resolve();
    expect([calls(spy), calls(solve)]).toEqual([0, 1]);
    send("single-use-token");
    await expect(Promise.all(reads)).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls[0]).toEqual([SESS_URL, expect.objectContaining({ method: "POST", credentials: "same-origin", body: '{"token":"single-use-token"}' })]);
    expect(storage.setItem).toHaveBeenCalledWith(EXP_KEY, expect.stringMatching(/^\d+$/));
    expect([state(), mark.mock.calls.map(([n]) => n)]).toEqual(["ready", ["pharos-session-token", "pharos-session-ready"]]);
    expect(gtag).toHaveBeenCalledExactlyOnceWith("event", "site_session_ready", {});
    expect(Number(storage.setItem.mock.calls[0]![1])).toBeCloseTo(nowSec() + 604800, 0);
  });

  it.each([200, 401])("retries hinted 401 once (final %s)", async (status) => {
    const { api, storage, fetchCoins, reg, recover: onRec, valid } = await setup();
    storage.setItem(EXP_KEY, String(nowSec() + 7200));
    const [ch, rec] = [vi.fn(async () => "token"), vi.fn()];
    onRec(rec);
    reg(ch);
    const spy = spyFetch().mockResolvedValueOnce(required()).mockResolvedValueOnce(sessionRes()).mockResolvedValueOnce(status === 200 ? okJson() : required());
    const res = fetchCoins();
    if (status === 200) await expect(res).resolves.toEqual({ ok: true });
    else {
      await expect(res).rejects.toMatchObject({ name: "ApiFetchError", status: 401, bodyText: "session required" });
      await expect(res).rejects.toBeInstanceOf(api.SiteSessionRequiredError);
    }
    expect(storage.removeItem).toHaveBeenCalledWith(EXP_KEY);
    expect([calls(spy), calls(ch), valid(), calls(rec)]).toEqual([3, 1, status === 200, 1]);
  });

  it("handles hinted bootstrap 401", async () => {
    const { fetchCoins, reg } = await setup();
    reg(async () => "token");
    window.__pharosDataBootstrap = {
      version: 1, route: "/", expiresAt: Date.now() + 10000, discard: vi.fn(),
      entries: new Map([[JSON.stringify(["test"]), {
        url: `${SITE}/stablecoins`, accept: PUBLIC_API_ACCEPT, controller: new AbortController(),
        outcome: Promise.resolve({ ok: true as const, body: { status: 401, headers: [["X-Pharos-Session", "required"]] as [string, string][], bodyText: "required" } }),
      }]]),
    };
    const spy = spyFetch().mockResolvedValueOnce(sessionRes()).mockResolvedValueOnce(okJson());
    await expect(fetchCoins({ bootstrapQueryKey: ["test"] })).resolves.toEqual({ ok: true });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("bounds waits; honors abort", async () => {
    const { fetchCoins, reg, state } = await setup();
    reg((sig) => new Promise((_res, rej) => { sig.addEventListener("abort", () => rej(sig.reason), { once: true }); }));
    const spy = spyFetch().mockResolvedValueOnce(okJson());
    const pending = fetchCoins(), ctl = new AbortController();
    const aborted = expect(fetchCoins({ signal: ctl.signal })).rejects.toMatchObject({ name: "AbortError" });
    ctl.abort();
    await aborted;
    await advance(2999);
    expect(spy).not.toHaveBeenCalled();
    await advance(1);
    await expect(pending).resolves.toEqual({ ok: true });
    await advance(50_000);
    expect(state()).toBe("unavailable");
  });

  it("caps retries despite blocked storage", async () => {
    const { api, storage, fetchCoins, reg, ensure, state, paused } = await setup();
    const blocked = () => { throw new Error("blocked"); };
    storage.getItem.mockImplementation(blocked);
    storage.removeItem.mockImplementation(blocked);
    const ch = vi.fn(async () => { throw new Error("blocked"); });
    reg(ch);
    const first = ensure();
    expect(ensure()).toBe(first);
    const failed = expect(first).rejects.toThrow("unavailable");
    await advance(999);
    expect(ch).toHaveBeenCalledOnce();
    await advance(2001);
    await failed;
    expect([calls(ch), state(), paused()]).toEqual([3, "unavailable", false]);
    const spy = spyFetch().mockImplementation(async () => required());
    await expect(fetchCoins()).rejects.toBeInstanceOf(api.ApiFetchError);
    expect([calls(spy), calls(ch), paused()]).toEqual([2, 3, true]);
  });

  it("bypasses admin and direct API", async () => {
    const { api, fetchCoins, reg } = await setup(), ch = vi.fn();
    reg(ch);
    const spy = spyFetch().mockImplementation(async () => required());
    await expect(api.apiFetch("/api/admin/status")).rejects.toBeInstanceOf(api.ApiFetchError);
    vi.stubEnv("NEXT_PUBLIC_API_BASE", "https://api.pharos.watch");
    await expect(fetchCoins()).rejects.toBeInstanceOf(api.ApiFetchError);
    expect([calls(spy), calls(ch)]).toEqual([2, 0]);
  });

  it.each([204, 503])("renews visibly within 24h (%s)", async (status) => {
    const { storage, fetchCoins, reg, renew, ensure, state, valid, paused } = await setup(), time = Date.now();
    storage.setItem(EXP_KEY, String(Math.floor(time / 1000) + 86400));
    storage.setItem.mockImplementation(() => { throw new Error("blocked"); });
    const solve = vi.fn(() => new Promise<string>((done) => setTimeout(done, 4000, "token")));
    reg(solve);
    vis("visible");
    renew();
    expect([state(), calls(solve)]).toEqual(["ready", 0]);
    vi.setSystemTime(time + 1000);
    vis("hidden");
    renew();
    expect(solve).not.toHaveBeenCalled();
    const spy = spyFetch().mockImplementation(async (u) => u === SESS_URL ? (status === 204 ? sessionRes() : new Response(null, { status })) : okJson());
    vis("visible");
    renew();
    const task = ensure(true).catch(() => {});
    await expect(fetchCoins()).resolves.toEqual({ ok: true });
    await advance(15000);
    await task;
    expect([calls(spy), valid(), state(), paused()]).toEqual([status === 204 ? 2 : 4, true, "ready", false]);
  });

  it.each(["", "NaN", "1.5", "9999999999999999"])("never stores invalid expiry %s", async (expiry) => {
    const { storage, reg, ensure, valid } = await setup();
    reg(async () => "token");
    spyFetch().mockImplementation(async () => new Response(null, { status: 204, headers: { "X-Pharos-Session-Expires": expiry } }));
    const failed = expect(ensure()).rejects.toThrow("unavailable");
    await advance(3000);
    await failed;
    expect([calls(storage.setItem), valid()]).toEqual([0, false]);
  });
});
