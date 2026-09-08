import { describe, expect, it, vi } from "vitest";
import { createR2MeasurementsClient } from "../lib/r2-measurements-client";

const credentials = {
  accountId: "account-123",
  accessKeyId: "access-key",
  secretAccessKey: "secret-key",
  now: () => new Date("2026-09-03T12:34:56.000Z"),
};

describe("R2 measurements client", () => {
  it("matches an independent SigV4 vector for reserved URI bytes and normalized headers", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    const client = createR2MeasurementsClient({ ...credentials, fetch: fetchMock });
    await client.put("captures/a b!+?#.json.gz", new TextEncoder().encode("body"), {
      contentType: " application/json;  \tcharset=utf-8 ",
      contentEncoding: "gzip",
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(url).toBe("https://account-123.r2.cloudflarestorage.com/pharos-measurements/captures/a%20b%21%2B%3F%23.json.gz");
    expect(init?.method).toBe("PUT");
    expect(init?.body).toEqual(Buffer.from("body"));
    const headers = new Headers(init?.headers);
    // Independently calculated with Python hashlib/hmac from the literal canonical request.
    expect(headers.get("x-amz-content-sha256")).toBe("230d8358dc8e8890b4c58deeb62912ee2f20357ae92a5cc861b98e68fe31acb5");
    expect(headers.get("authorization")).toBe("AWS4-HMAC-SHA256 Credential=access-key/20260903/auto/s3/aws4_request, SignedHeaders=content-encoding;content-type;host;x-amz-content-sha256;x-amz-date, Signature=fc0a531814821839f4e4642379d0c1eb1db7b7545eb4f71468c847835fa6bee3");
  });

  it("returns GET bytes and distinguishes missing objects from successful HEAD metadata", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("compressed"))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { headers: {
        etag: '"version-1"', "content-length": "123", "content-type": "application/gzip",
      } }));
    const client = createR2MeasurementsClient({ ...credentials, fetch: fetchMock });
    await expect(client.get("capture.gz")).resolves.toEqual(Buffer.from("compressed"));
    await expect(client.get("missing.gz")).resolves.toBeNull();
    await expect(client.head("missing.gz")).resolves.toBeNull();
    await expect(client.head("capture.gz")).resolves.toEqual({
      etag: '"version-1"', contentLength: 123, contentType: "application/gzip",
    });
  });

  it("refuses traversal and absolute keys before fetching", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = createR2MeasurementsClient({ ...credentials, fetch: fetchMock });
    for (const key of ["../capture", "captures/../secret", "/absolute", "captures\\secret"]) {
      await expect(client.get(key)).rejects.toThrow(/relative path/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires each credential before fetching", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    expect(() => createR2MeasurementsClient({ ...credentials, accountId: "", fetch: fetchMock })).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
    for (const field of ["accessKeyId", "secretAccessKey"] as const) {
      const client = createR2MeasurementsClient({ ...credentials, [field]: "", fetch: fetchMock });
      await expect(client.get("capture.gz")).rejects.toThrow(/Missing R2_MEASUREMENTS_/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates non-404 HTTP failures for every method", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 503 }));
    const client = createR2MeasurementsClient({ ...credentials, fetch: fetchMock });
    await expect(client.put("capture.gz", new Uint8Array())).rejects.toThrow(/PUT.*503/);
    await expect(client.get("capture.gz")).rejects.toThrow(/GET.*503/);
    await expect(client.head("capture.gz")).rejects.toThrow(/HEAD.*503/);
  });
});
