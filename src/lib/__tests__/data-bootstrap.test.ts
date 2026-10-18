import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { runInNewContext } from "node:vm";
import { addNonceToInlineScripts } from "@shared/lib/site-csp";
import { isSiteDataAllowedUiHostname } from "@shared/lib/site-data-lane";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";
import { getHomepageDataBootstrapScript, getStablecoinDetailDataBootstrapScript } from "@/lib/data-bootstrap-script";
import { ApiFetchError, SchemaValidationError, seedStablecoinDetailQueryCache } from "@/lib/api";
import { PUBLIC_API_ACCEPT } from "@/lib/api-request-policy";
import { getSiteDataBootstrapPolicy } from "@/lib/api-url";
import { createApiPollingQueryOptions, createApiPollingQueryOptionsWithMeta } from "@/hooks/use-api-query";
import { claimDataBootstrap, discardDataBootstrap, hasDataBootstrap, startDataBootstrap, type DataBootstrapConfig } from "../data-bootstrap";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "../request-lifecycle";
import { asMetaQueryOptions, createRegisteredApiPollingQueryOptions } from "@/hooks/api-hooks";
import { reconcileStablecoinLiveSummary } from "@/lib/stablecoin-live-summary-query";
import { projectStablecoinLiveSummary } from "@shared/lib/stablecoin-live-summary";
import { StablecoinDetailResponseSchema } from "@shared/types/market";

const schema = z.object({ value: z.number() });
const key = ["bootstrap-test"] as const;
const path = "/api/stablecoins";
const url = "/_site-data/stablecoins";
const clients: QueryClient[] = [];
let browser: EventTarget & { location: { hostname: string; pathname: string } };

function config(overrides: Partial<DataBootstrapConfig> = {}): DataBootstrapConfig {
  return {
    route: "/",
    requests: [{ key: JSON.stringify(key), url }],
    accept: PUBLIC_API_ACCEPT,
    timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    handoffMs: 2 * DEFAULT_REQUEST_TIMEOUT_MS,
    policy: { disabled: false, anyHostname: false, hostnames: ["pharos.watch"], hostnameSuffix: ".example.pages.dev" },
    ...overrides,
  };
}

function client() {
  const result = new QueryClient();
  clients.push(result);
  return result;
}

function options() {
  return createApiPollingQueryOptions(key, path, 60_000, { schema, retry: false, staleTime: 0 });
}

beforeEach(() => {
  browser = Object.assign(new EventTarget(), { location: { hostname: "pharos.watch", pathname: "/" } });
  vi.stubGlobal("window", browser);
});

afterEach(() => {
  discardDataBootstrap();
  for (const queryClient of clients.splice(0)) queryClient.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("document data bootstrap", () => {
  it.each([false, true])("adopts pending/settled transport once and dedupes canonical observers (settled=%s)", async (settled) => {
    let release!: (value: Response) => void;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    startDataBootstrap(config());
    expect(fetchSpy).toHaveBeenCalledOnce();
    const response = new Response('{"value":7}');
    if (settled) {
      release(response);
      await Promise.resolve();
      await Promise.resolve();
    }
    const queryClient = client();
    const first = queryClient.fetchQuery(options());
    const observer = queryClient.fetchQuery(options());
    if (!settled) release(response);
    await expect(first).resolves.toEqual({ value: 7 });
    await expect(observer).resolves.toEqual({ value: 7 });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get("Accept")).toBe(PUBLIC_API_ACCEPT);
    expect(window.__pharosDataBootstrap?.entries.size).toBe(0);

    fetchSpy.mockResolvedValueOnce(new Response('{"value":8}'));
    await expect(queryClient.fetchQuery(options())).resolves.toEqual({ value: 8 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("starts normal transport before a lazy schema resolves and never admits unvalidated data", async () => {
    let resolveSchema!: (value: typeof schema) => void;
    const lazySchema = () => new Promise<typeof schema>((resolve) => { resolveSchema = resolve; });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"value":3}'));
    const queryClient = client();
    const pending = queryClient.fetchQuery(createApiPollingQueryOptions(key, path, 60_000, { schema: lazySchema, retry: false }));
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(queryClient.getQueryData(key)).toBeUndefined();
    resolveSchema(schema);
    await expect(pending).resolves.toEqual({ value: 3 });
  });

  it("falls back normally when absent and retries failed startup with the normal transport", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response('{"value":1}'));
    await expect(client().fetchQuery(options())).resolves.toEqual({ value: 1 });
    fetchSpy.mockRejectedValueOnce(new TypeError("offline"));
    startDataBootstrap(config());
    await Promise.resolve();
    fetchSpy.mockResolvedValueOnce(new Response('{"value":2}'));
    await expect(client().fetchQuery({ ...options(), retry: 1, retryDelay: () => 0 })).resolves.toEqual({ value: 2 });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["{", SyntaxError],
    ['{"value":"bad"}', SchemaValidationError],
  ] as const)("rejects invalid startup bodies without publishing them (%s)", async (body, errorClass) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
    startDataBootstrap(config());
    const queryClient = client();
    await expect(queryClient.fetchQuery(options())).rejects.toBeInstanceOf(errorClass);
    expect(queryClient.getQueryData(key)).toBeUndefined();
  });

  it("preserves HTTP errors and their raw body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unavailable", { status: 503 }));
    startDataBootstrap(config());
    await expect(client().fetchQuery(options())).rejects.toMatchObject({
      name: "ApiFetchError", path, status: 503, bodyText: "unavailable",
    } satisfies Partial<ApiFetchError>);
  });

  it("preserves HTTP status when an error body cannot be consumed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.error(new Error("body unreadable")); },
    }), { status: 503 }));
    startDataBootstrap(config());
    await expect(client().fetchQuery(options())).rejects.toMatchObject({
      name: "ApiFetchError", status: 503, bodyText: null,
    });
  });

  it("uses normal metadata extraction without replacing stale producer clocks", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"value":4}', { headers: {
      "X-Data-Updated-At": "100", "X-Data-Age": "50", "X-Data-Freshness": "stale", Warning: "110 - stale",
    } }));
    startDataBootstrap(config());
    const query = createApiPollingQueryOptionsWithMeta(key, path, 60_000, { schema, retry: false });
    await expect(client().fetchQuery(query)).resolves.toMatchObject({
      data: { value: 4 }, meta: { updatedAt: 100, status: "stale", warning: "110 - stale" },
    });
  });

  it("cancels adopted pending transport with the exact query abort reason", async () => {
    let networkSignal!: AbortSignal;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      networkSignal = init!.signal!;
      return new Promise((_resolve, reject) => networkSignal.addEventListener("abort", () => reject(networkSignal.reason)));
    });
    startDataBootstrap(config());
    const controller = new AbortController();
    const adopted = claimDataBootstrap(key, url, { headers: { Accept: PUBLIC_API_ACCEPT }, signal: controller.signal });
    const reason = new DOMException("query cancelled", "AbortError");
    controller.abort(reason);
    await expect(adopted).rejects.toBe(reason);
    expect(networkSignal.aborted).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("honors an already aborted claim without issuing another request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"value":1}'));
    startDataBootstrap(config());
    const controller = new AbortController();
    controller.abort(new DOMException("already cancelled", "AbortError"));
    await expect(claimDataBootstrap(key, url, { headers: { Accept: PUBLIC_API_ACCEPT }, signal: controller.signal }))
      .rejects.toBe(controller.signal.reason);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("does not publish a completed body when cancelled during schema resolution", async () => {
    let resolveSchema!: (value: typeof schema) => void;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"value":1}'));
    startDataBootstrap(config());
    const startup = window.__pharosDataBootstrap!.entries.get(JSON.stringify(key))!.outcome;
    const controller = new AbortController();
    const queryClient = client();
    const query = createApiPollingQueryOptions(key, path, 60_000, {
      schema: () => new Promise<typeof schema>((resolve) => { resolveSchema = resolve; }),
      fetchInit: { signal: controller.signal }, retry: false,
    });
    const pending = queryClient.fetchQuery(query);
    await startup;
    controller.abort(new DOMException("cancelled before validation", "AbortError"));
    resolveSchema(schema);
    await expect(pending).rejects.toBe(controller.signal.reason);
    expect(queryClient.getQueryData(key)).toBeUndefined();
  });

  it("keeps the original timeout through body drain rather than restarting at adoption", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => ({
      status: 200, headers: new Headers(),
      text: () => new Promise<string>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason))),
    } as Response));
    startDataBootstrap(config());
    await vi.advanceTimersByTimeAsync(5000);
    const pending = client().fetchQuery(options());
    const rejection = expect(pending).rejects.toMatchObject({ name: "TimeoutError", message: "API request timed out after 10000ms" });
    await vi.advanceTimersByTimeAsync(5000);
    await rejection;
  });

  it.each(["pagehide", "popstate", "provider", "expired"])("discards startup on %s and cannot reuse it on A → B → A", async (kind) => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response('{"value":1}'));
    startDataBootstrap(config());
    if (kind === "provider") discardDataBootstrap();
    else if (kind === "expired") await vi.advanceTimersByTimeAsync(2 * DEFAULT_REQUEST_TIMEOUT_MS);
    else browser.dispatchEvent(new Event(kind));
    browser.location.pathname = "/other/";
    browser.location.pathname = "/";
    startDataBootstrap(config());
    await expect(client().fetchQuery(options())).resolves.toEqual({ value: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not lend transport to other descriptor identities or mismatched request policies", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"value":1}'));
    startDataBootstrap(config());
    expect(claimDataBootstrap(["different-key"], url, { headers: { Accept: PUBLIC_API_ACCEPT } })).toBeUndefined();
    expect(window.__pharosDataBootstrap?.entries.size).toBe(1);
    expect(claimDataBootstrap(key, url, { headers: { Accept: PUBLIC_API_ACCEPT, "X-Custom": "1" } })).toBeUndefined();
    expect(window.__pharosDataBootstrap?.entries.size).toBe(0);
  });

  it("does not bootstrap other routes, unadmitted hosts or an explicit API-base override", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    startDataBootstrap(config({ route: "/other/" }));
    browser.location.hostname = "untrusted.example";
    startDataBootstrap(config());
    browser.location.hostname = "pharos.watch";
    vi.stubEnv("NEXT_PUBLIC_API_BASE", "https://custom.example");
    startDataBootstrap(config({ policy: getSiteDataBootstrapPolicy() }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("executes the serialized route manifest as a plain nonced parser script", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response('{"value":1}'));
    const script = getHomepageDataBootstrapScript();
    const html = addNonceToInlineScripts(`<script id="bootstrap">${script}</script>`, "response-nonce");
    expect(html).toContain('<script nonce="response-nonce" id="bootstrap">');
    runInNewContext(script, { window: browser, fetch: fetchSpy, setTimeout, clearTimeout, AbortController, DOMException, Date });
    expect(fetchSpy.mock.calls.map(([input]) => input)).toEqual([
      "/_site-data/homepage-snapshot", "/_site-data/stability-index",
    ]);
    expect(Array.from(window.__pharosDataBootstrap!.entries.keys())).toEqual([
      JSON.stringify(FRONTEND_API_QUERY_DESCRIPTORS.homepageSnapshot.queryKey),
      JSON.stringify(FRONTEND_API_QUERY_DESCRIPTORS.stabilityIndex.queryKey),
    ]);
  });

  it.each(["pharos.watch", "ops.pharos.watch", "stablecoin-dashboard.pages.dev", "preview.stablecoin-dashboard.pages.dev", "localhost", "untrusted.example"])(
    "derives parser hostname admission from the normal site-data policy (%s)", (hostname) => {
      vi.stubEnv("NEXT_PUBLIC_API_BASE", "");
      vi.stubEnv("NEXT_PUBLIC_FORCE_SITE_DATA_PROXY", "");
      const policy = getSiteDataBootstrapPolicy();
      const admitted = policy.hostnames.includes(hostname) || hostname.endsWith(policy.hostnameSuffix);
      expect(admitted).toBe(isSiteDataAllowedUiHostname(hostname));
    },
  );

  it("respects forced local/preview proxy routing", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"value":1}'));
    vi.stubEnv("NEXT_PUBLIC_API_BASE", "");
    vi.stubEnv("NEXT_PUBLIC_FORCE_SITE_DATA_PROXY", "true");
    browser.location.hostname = "localhost";
    startDataBootstrap(config({ policy: getSiteDataBootstrapPolicy() }));
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it.each([false, true])("adopts the detail parser request once with original producer clocks (settled=%s)", async (settled) => {
    browser.location.pathname = "/stablecoin/usdt-tether/";
    const { promise, resolve: release } = Promise.withResolvers<Response>();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => promise);
    const script = getStablecoinDetailDataBootstrapScript("usdt-tether");
    runInNewContext(script, { window: browser, fetch: fetchSpy, setTimeout, clearTimeout, AbortController, DOMException, Date });
    const summary = {
      price: 1, priceSource: null, priceConfidence: null, priceUpdatedAt: 100, priceObservedAt: 90,
      supplyObservedAt: 80, circulating: { peggedUSD: 10 }, circulatingPrevDay: {},
      circulatingPrevWeek: {}, circulatingPrevMonth: {}, nativeSupply: { current: 10, prevWeek: null, prevMonth: null },
    };
    const response = new Response(JSON.stringify(summary), { headers: { "X-Data-Updated-At": "100" } });
    if (settled) {
      release(response);
      await Promise.resolve();
      await Promise.resolve();
    }
    const descriptor = FRONTEND_API_QUERY_DESCRIPTORS.stablecoinLiveSummary("usdt-tether");
    expect(hasDataBootstrap(descriptor.queryKey)).toBe(true);
    const options = { ...asMetaQueryOptions(createRegisteredApiPollingQueryOptions(descriptor)), retry: false, staleTime: 0 };
    const queryClient = client();
    const first = queryClient.fetchQuery(options);
    const second = queryClient.fetchQuery(options);
    if (!settled) release(response);
    await expect(first).resolves.toMatchObject({ data: summary, meta: { updatedAt: 100 } });
    await second;
    expect(hasDataBootstrap(descriptor.queryKey)).toBe(false);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/_site-data/stablecoin-live-summary/usdt-tether");
    expect(new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get("Accept")).toBe(PUBLIC_API_ACCEPT);
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(summary)));
    await queryClient.fetchQuery(options);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("discards a detail request on coin mismatch and aborts a claimed detail attempt", async () => {
    browser.location.pathname = "/stablecoin/usdt-tether/";
    let networkSignal!: AbortSignal;
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      networkSignal = init!.signal!;
      const { promise, reject } = Promise.withResolvers<Response>();
      networkSignal.addEventListener("abort", () => reject(networkSignal.reason));
      return promise;
    });
    runInNewContext(getStablecoinDetailDataBootstrapScript("usdt-tether"), {
      window: browser, fetch, setTimeout, clearTimeout, AbortController, DOMException, Date,
    });
    const key = FRONTEND_API_QUERY_DESCRIPTORS.stablecoinLiveSummary("usdt-tether").queryKey;
    expect(claimDataBootstrap(["stablecoin-live-summary", "usdc-circle"], "/_site-data/stablecoin-live-summary/usdc-circle", {
      headers: { Accept: PUBLIC_API_ACCEPT },
    })).toBeUndefined();
    const controller = new AbortController();
    const adopted = claimDataBootstrap(key, "/_site-data/stablecoin-live-summary/usdt-tether", {
      headers: { Accept: PUBLIC_API_ACCEPT }, signal: controller.signal,
    });
    controller.abort(new DOMException("detail unmounted", "AbortError"));
    await expect(adopted).rejects.toBe(controller.signal.reason);
    expect(networkSignal.aborted).toBe(true);
  });

  it("retains newer seeded detail values when an adopted response is older, without claiming live freshness", async () => {
    browser.location.pathname = "/stablecoin/usdt-tether/";
    const summary = {
      price: 1, priceSource: null, priceConfidence: null, priceUpdatedAt: 200, priceObservedAt: 190,
      supplyObservedAt: 180, circulating: {}, circulatingPrevDay: {}, circulatingPrevWeek: {},
      circulatingPrevMonth: {}, nativeSupply: { current: null, prevWeek: null, prevMonth: null },
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ...summary, price: 0.5 }), {
      headers: { "X-Data-Updated-At": "100" },
    }));
    runInNewContext(getStablecoinDetailDataBootstrapScript("usdt-tether"), {
      window: browser, fetch, setTimeout, clearTimeout, AbortController, DOMException, Date,
    });
    const queryClient = client();
    seedStablecoinDetailQueryCache(queryClient, {
      version: 1, stablecoinId: "usdt-tether", generatedAt: Date.now(), updatedAt: { liveSummary: 200_000 },
      lanes: { liveSummary: summary },
    });
    const descriptor = FRONTEND_API_QUERY_DESCRIPTORS.stablecoinLiveSummary("usdt-tether");
    await queryClient.fetchQuery({ ...asMetaQueryOptions(createRegisteredApiPollingQueryOptions(descriptor)), staleTime: 0 });
    expect(queryClient.getQueryData(descriptor.queryKey)).toMatchObject({
      data: summary, meta: { updatedAt: 200, status: "stale", reason: "older-live-generation-retained" },
    });
  });

  it("falls back to the canonical detail transport without a matching document entry", async () => {
    browser.location.pathname = "/stablecoin/usdc-circle/";
    const summary = {
      price: 1, priceSource: null, priceConfidence: null, priceUpdatedAt: null, priceObservedAt: null,
      supplyObservedAt: null, circulating: {}, circulatingPrevDay: {}, circulatingPrevWeek: {},
      circulatingPrevMonth: {}, nativeSupply: { current: null, prevWeek: null, prevMonth: null },
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(summary)));
    runInNewContext(getStablecoinDetailDataBootstrapScript("usdt-tether"), {
      window: browser, fetch, setTimeout, clearTimeout, AbortController, DOMException, Date,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    const descriptor = FRONTEND_API_QUERY_DESCRIPTORS.stablecoinLiveSummary("usdc-circle");
    expect(hasDataBootstrap(descriptor.queryKey)).toBe(false);
    await expect(client().fetchQuery(asMetaQueryOptions(createRegisteredApiPollingQueryOptions(descriptor))))
      .resolves.toMatchObject({ data: summary });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/_site-data/stablecoin-live-summary/usdc-circle");
  });

  it("adopts independently changing supply, quarantine, price and history at equal aggregate clocks", () => {
    const historyAt = 1_790_000_000;
    const supplyAt = historyAt + 100;
    const detail = StablecoinDetailResponseSchema.parse({
      price: 1, priceSource: "coingecko", priceConfidence: "single-source",
      priceUpdatedAt: supplyAt, currentCirculatingUSD: { peggedUSD: 100 },
      currentSupplyObservedAt: supplyAt,
      tokens: [{ date: supplyAt - 7 * 86400, totalCirculating: { peggedUSD: 90 }, totalCirculatingUSD: { peggedUSD: 90 } }],
    });
    const meta = { updatedAt: historyAt, ageSeconds: 0, status: "fresh" as const };
    const previous = { data: projectStablecoinLiveSummary(detail), meta };
    const overlays = [
      { ...detail, currentCirculatingUSD: { peggedUSD: 120 }, currentSupplyObservedAt: supplyAt + 100 },
      { ...detail, currentSupplyUnavailableReason: "canonical-supply-quarantined" },
      { ...detail, price: 0.97, priceSource: "defillama", priceUpdatedAt: supplyAt + 100 },
    ];
    for (const overlay of overlays) {
      const incoming = { data: projectStablecoinLiveSummary(overlay), meta: { ...meta, status: "degraded" as const } };
      expect(reconcileStablecoinLiveSummary(previous, incoming)).toEqual(incoming);
      expect(incoming.data).not.toEqual(previous.data);
    }
    const quarantine = reconcileStablecoinLiveSummary(previous, {
      data: projectStablecoinLiveSummary(overlays[1]), meta,
    });
    expect(quarantine.data.circulating).toEqual({});
    expect(quarantine.data.nativeSupply.current).toBeNull();
    // Inverse ordering: canonical publication remains the minimum while the
    // provider publishes a corrected historical checkpoint in a newer cache row.
    const canonical = { ...detail, currentSupplyObservedAt: historyAt };
    const olderHistory = { data: projectStablecoinLiveSummary(canonical), meta };
    const newerHistory = { data: projectStablecoinLiveSummary({
      ...canonical,
      tokens: [{ date: historyAt - 7 * 86400, totalCirculating: { peggedUSD: 95 }, totalCirculatingUSD: { peggedUSD: 95 } }],
    }), meta };
    expect(reconcileStablecoinLiveSummary(olderHistory, newerHistory).data.nativeSupply.prevWeek).toBe(95);
    const newer = { data: previous.data, meta: { ...meta, updatedAt: historyAt + 1 } };
    expect(reconcileStablecoinLiveSummary(previous, newer)).toEqual(newer);
    const unknown = { data: previous.data, meta: null };
    expect(reconcileStablecoinLiveSummary(previous, unknown)).toMatchObject({
      data: previous.data, meta: { updatedAt: historyAt, status: "stale", reason: "older-live-generation-retained" },
    });
  });
});
