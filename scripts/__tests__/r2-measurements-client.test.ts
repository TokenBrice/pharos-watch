import { describe, expect, it, vi } from "vitest";
import { createR2MeasurementsClient } from "../lib/r2-measurements-client";

describe("R2 measurements client", () => {
  it("signs a path-style PUT with the configured account and auto region", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    const client = createR2MeasurementsClient({
      accountId: "account-123",
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
      fetch: fetchMock,
      now: () => new Date("2026-09-03T12:34:56.000Z"),
    });

    await client.put("captures/lusd-liquity/2026-09-03.json.gz", new TextEncoder().encode("body"), {
      contentType: "application/json",
      contentEncoding: "gzip",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://account-123.r2.cloudflarestorage.com/pharos-measurements/captures/lusd-liquity/2026-09-03.json.gz");
    expect(init?.method).toBe("PUT");
    const headers = new Headers(init?.headers);
    expect(headers.get("host")).toBe("account-123.r2.cloudflarestorage.com");
    expect(headers.get("x-amz-date")).toBe("20260903T123456Z");
    expect(headers.get("x-amz-content-sha256")).toMatch(/^[a-f0-9]{64}$/);
    expect(headers.get("authorization")).toContain("Credential=access-key/20260903/auto/s3/aws4_request");
    expect(headers.get("authorization")).toContain("SignedHeaders=content-encoding;content-type;host;x-amz-content-sha256;x-amz-date");
  });

  it("returns body bytes for GET and null for missing HEAD objects", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(new TextEncoder().encode("compressed"), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const client = createR2MeasurementsClient({
      accountId: "account-123",
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
      fetch: fetchMock,
      now: () => new Date("2026-09-03T12:34:56.000Z"),
    });

    await expect(client.get("captures/test/one.json.gz")).resolves.toEqual(Buffer.from("compressed"));
    await expect(client.head("captures/test/one.json.gz")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("HEAD");
  });
});
