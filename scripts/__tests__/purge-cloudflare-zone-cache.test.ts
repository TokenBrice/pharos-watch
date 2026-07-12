import { describe, expect, it, vi } from "vitest";
import {
  parseZoneCachePurgeArgs,
  purgeCloudflareZoneCache,
  runZoneCachePurgeCli,
} from "../maintenance/purge-cloudflare-zone-cache.mjs";

const noRetry = { maxAttempts: 1, retryDelayMs: 0 };
const zoneResponse = () =>
  new Response(
    JSON.stringify({
      success: true,
      result: [{ id: "zone-1", name: "pharos.watch", status: "active" }],
    }),
    { status: 200 },
  );
const purgeResponse = () => new Response(JSON.stringify({ success: true, result: { id: "zone-1" } }), { status: 200 });

describe("purgeCloudflareZoneCache", () => {
  it("looks up one exact active zone before purging its entire cache", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(zoneResponse()).mockResolvedValueOnce(purgeResponse());

    await purgeCloudflareZoneCache({
      apiToken: "token-1",
      zoneName: "pharos.watch",
      fetchImpl: fetchMock,
      ...noRetry,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [lookupUrl, lookupInit] = fetchMock.mock.calls[0];
    expect(lookupUrl).toBeInstanceOf(URL);
    expect(lookupUrl.searchParams.get("name")).toBe("pharos.watch");
    expect(lookupUrl.searchParams.get("status")).toBe("active");
    expect(lookupUrl.searchParams.get("per_page")).toBe("5");
    expect(lookupInit.headers.Authorization).toBe("Bearer token-1");

    const [purgeUrl, purgeInit] = fetchMock.mock.calls[1];
    expect(purgeUrl).toBe("https://api.cloudflare.com/client/v4/zones/zone-1/purge_cache");
    expect(purgeInit.method).toBe("POST");
    expect(purgeInit.body).toBe(JSON.stringify({ purge_everything: true }));
  });

  it("refuses to purge when the zone lookup is empty or ambiguous", async () => {
    for (const result of [
      [],
      [
        { id: "one", name: "pharos.watch" },
        { id: "two", name: "pharos.watch" },
      ],
    ]) {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ success: true, result }), { status: 200 }));
      await expect(
        purgeCloudflareZoneCache({
          apiToken: "token-1",
          zoneName: "pharos.watch",
          fetchImpl: fetchMock,
          ...noRetry,
        }),
      ).rejects.toThrow(/refusing to purge/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("refuses a lookup result whose name is not exact", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          result: [{ id: "zone-1", name: "other.example" }],
        }),
        { status: 200 },
      ),
    );

    await expect(
      purgeCloudflareZoneCache({
        apiToken: "token-1",
        zoneName: "pharos.watch",
        fetchImpl: fetchMock,
        ...noRetry,
      }),
    ).rejects.toThrow(/refusing to purge/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry terminal authentication failures", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ message: "Authentication error" }],
        }),
        { status: 401 },
      ),
    );

    await expect(
      purgeCloudflareZoneCache({
        apiToken: "token-1",
        zoneName: "pharos.watch",
        fetchImpl: fetchMock,
        maxAttempts: 3,
        retryDelayMs: 0,
      }),
    ).rejects.toThrow(/Authentication error/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a transient purge failure after a successful one-time lookup", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(zoneResponse())
      .mockResolvedValueOnce(new Response("upstream unavailable", { status: 502 }))
      .mockResolvedValueOnce(purgeResponse());

    await purgeCloudflareZoneCache({
      apiToken: "token-1",
      zoneName: "pharos.watch",
      fetchImpl: fetchMock,
      maxAttempts: 3,
      retryDelayMs: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("validates DNS zone names before making a request", async () => {
    const fetchMock = vi.fn();
    await expect(
      purgeCloudflareZoneCache({
        apiToken: "token-1",
        zoneName: "https://pharos.watch/path",
        fetchImpl: fetchMock,
        ...noRetry,
      }),
    ).rejects.toThrow(/valid DNS zone name/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("zone cache purge CLI", () => {
  it("parses the explicit zone and dry-run flag", () => {
    expect(parseZoneCachePurgeArgs(["--zone", "PHAROS.WATCH", "--dry-run"])).toEqual({
      zone: "pharos.watch",
      dryRun: true,
      help: false,
    });
  });

  it("allows dry-run without a credential and never calls fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runZoneCachePurgeCli(["--dry-run"], { NODE_ENV: "test" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("pharos.watch"));
    fetchSpy.mockRestore();
    logSpy.mockRestore();
  });
});
