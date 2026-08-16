import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetchStrict } from "../../worker/src/test-helpers/__shared/mock-fetch";
import {
  apiFetchHeaders,
  fetchWithRetry,
  preserveExistingJsonArrayOnFetchFailure,
  resolveApiPathUrl,
  shouldAllowExistingDataOnFetchFailure,
} from "../lib/sync-from-api";

const tempRoots: string[] = [];

describe("fetchWithRetry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { force: true, recursive: true });
    }
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
    const root = mkdtempSync(join(tmpdir(), "pharos-sync-fallback-"));
    tempRoots.push(root);
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
    const root = mkdtempSync(join(tmpdir(), "pharos-sync-fallback-"));
    tempRoots.push(root);
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
