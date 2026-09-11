import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetchStrict } from "@shared/test-utils/mock-fetch";
import {
  apiFetchHeaders,
  fetchWithRetry,
  preserveExistingJsonArrayOnFetchFailure,
  resolveApiPathUrl,
  shouldAllowExistingDataOnFetchFailure,
} from "../lib/sync-from-api";
import { createTempRepoTracker } from "./helpers/test-state";

const { cleanup, makeRoot } = createTempRepoTracker("pharos-sync-fallback");

describe("fetchWithRetry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    cleanup();
  });

  it("keeps the site API credential off untrusted or unresolved API reads", () => {
    vi.stubEnv("DIGEST_API_KEY", "public-key");
    vi.stubEnv("SITE_API_SHARED_SECRET", "site-secret");

    expect(apiFetchHeaders(["DIGEST_API_KEY"])).toEqual({
      Accept: "application/json",
      "X-API-Key": "public-key",
    });
    expect(apiFetchHeaders(["DIGEST_API_KEY"], { url: "https://attacker.example/api/digest-archive" })).toEqual({
      Accept: "application/json",
      "X-API-Key": "public-key",
    });
  });

  it("adds the site API credential only for trusted direct site API reads", () => {
    vi.stubEnv("DIGEST_API_KEY", "public-key");
    vi.stubEnv("SITE_API_SHARED_SECRET", "site-secret");

    expect(apiFetchHeaders(["DIGEST_API_KEY"], { url: "https://site-api.pharos.watch/api/digest-archive" })).toEqual({
      Accept: "application/json",
      "X-Pharos-Site-Proxy-Secret": "site-secret",
    });
    expect(
      apiFetchHeaders(["DIGEST_API_KEY"], { url: "https://pharos-watch-preview.workers.dev/api/digest-archive" }),
    ).toEqual({
      Accept: "application/json",
      "X-API-Key": "public-key",
    });

    vi.stubEnv("SITE_API_SHARED_SECRET_TRUSTED_ORIGINS", "https://pharos-watch-preview.workers.dev");
    expect(
      apiFetchHeaders(["DIGEST_API_KEY"], { url: "https://pharos-watch-preview.workers.dev/api/digest-archive" }),
    ).toEqual({
      Accept: "application/json",
      "X-Pharos-Site-Proxy-Secret": "site-secret",
    });
  });

  it("maps API paths onto the browser-facing site-data lane", () => {
    expect(resolveApiPathUrl("https://pharos.watch/_site-data", "/api/digest-archive")).toBe(
      "https://pharos.watch/_site-data/digest-archive",
    );
    expect(resolveApiPathUrl("https://pharos.watch/_site-data/", "/api/depeg-events?limit=1000")).toBe(
      "https://pharos.watch/_site-data/depeg-events?limit=1000",
    );
  });

  it("keeps site-data release reads browser-shaped", () => {
    vi.stubEnv("DIGEST_API_KEY", "public-key");
    vi.stubEnv("SITE_API_SHARED_SECRET", "site-secret");

    expect(
      apiFetchHeaders(["DIGEST_API_KEY"], {
        url: "https://stablecoin-dashboard.pages.dev/_site-data/digest-archive",
      }),
    ).toEqual({
      Accept: "application/json",
      Origin: "https://pharos.watch",
    });
  });

  it("cancels a failed streaming body before retrying", async () => {
    let cancelled = false;
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      if (calls++ === 0) {
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 503 });
      }
      expect(cancelled).toBe(true);
      return new Response("ok");
    });
    const response = await fetchWithRetry("https://api.pharos.watch/api/health", {}, {
      logLabel: "test", backoffMs: [0],
    });
    expect(await response.text()).toBe("ok");
  });

  it("aborts a hung fetch at the overall deadline without retrying", async () => {
    const fetchMock = vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchWithRetry("https://api.pharos.watch/api/health", {}, {
      logLabel: "test", timeoutMs: 10, backoffMs: [0],
    })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an already-aborted caller with its reason before fetching", async () => {
    const controller = new AbortController();
    const reason = new Error("caller stopped");
    controller.abort(reason);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchWithRetry("https://api.pharos.watch/api/health", { signal: controller.signal }, {
      logLabel: "test",
    })).rejects.toBe(reason);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops during backoff without issuing another attempt", async () => {
    const controller = new AbortController();
    const reason = new Error("caller stopped");
    let enteredBackoff!: () => void;
    const backoffStarted = new Promise<void>((resolve) => { enteredBackoff = resolve; });
    vi.spyOn(console, "log").mockImplementation(() => { enteredBackoff(); });
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = fetchWithRetry("https://api.pharos.watch/api/health", { signal: controller.signal }, {
      logLabel: "test", backoffMs: [60_000],
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError", cause: reason });
    try {
      await backoffStarted;
      controller.abort(reason);
      await rejected;
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort(reason);
    }
  });

  it("recovers from a transport exception", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce(new Response("recovered"));
    vi.stubGlobal("fetch", fetchMock);
    const response = await fetchWithRetry("https://api.pharos.watch/api/health", {}, {
      logLabel: "test", backoffMs: [0],
    });
    expect(await response.text()).toBe("recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves the final transport error at the configured attempt bound", async () => {
    const finalError = new TypeError("last connection reset");
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("first connection reset"))
      .mockRejectedValueOnce(finalError);
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchWithRetry("https://api.pharos.watch/api/health", {}, {
      logLabel: "test", attempts: 2, backoffMs: [0],
    })).rejects.toBe(finalError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries caller-declared transient statuses", async () => {
    const fetchMock = mockFetchStrict([{
      match: "https://api.pharos.watch/api/health",
      outcomes: [
        { body: "", status: 403 },
        { body: "ok", status: 200 },
      ],
    }]);

    const response = await fetchWithRetry(
      "https://api.pharos.watch/api/health",
      {},
      { logLabel: "test", retryStatuses: [403], backoffMs: [0] },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry undeclared client errors", async () => {
    const fetchMock = mockFetchStrict([{
      match: "https://api.pharos.watch/api/health",
      body: "",
      status: 401,
    }]);

    const response = await fetchWithRetry(
      "https://api.pharos.watch/api/health",
      {},
      { logLabel: "test", retryStatuses: [403], backoffMs: [0] },
    );

    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("recognizes the release fallback switch for existing data mirrors", () => {
    vi.stubEnv("PAGES_RELEASE_ALLOW_EXISTING_DATA_ON_FETCH_FAILURE", "1");

    expect(shouldAllowExistingDataOnFetchFailure()).toBe(true);
  });

  it("preserves a valid existing JSON array after a release-time fetch failure", () => {
    const root = makeRoot();
    const outputPath = join(root, "snapshot.json");
    writeFileSync(outputPath, JSON.stringify([{ id: "existing" }]));

    expect(
      preserveExistingJsonArrayOnFetchFailure({
        allow: true,
        error: new Error("API returned 403"),
        label: "test-sync",
        outputPath: new URL(`file://${outputPath}`),
      }),
    ).toBe(true);
  });

  it("rejects the existing-data fallback when the checked-in JSON is empty", () => {
    const root = makeRoot();
    const outputPath = join(root, "snapshot.json");
    writeFileSync(outputPath, "[]");

    expect(
      preserveExistingJsonArrayOnFetchFailure({
        allow: true,
        error: new Error("API returned 403"),
        label: "test-sync",
        outputPath: new URL(`file://${outputPath}`),
      }),
    ).toBe(false);
  });
});
