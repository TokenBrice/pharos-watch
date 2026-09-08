import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DEFAULT_REQUEST_JSON_MAX_BYTES,
  parseOptionalRequestJsonObject,
  parseRequestJsonWithSchema,
} from "../../lib/api-json-body";
import { makeJsonBodyRequest } from "../../test-helpers/__shared/auth";

const encoder = new TextEncoder();
const schema = z.object({ ok: z.boolean() });

function streamedRequest(chunks: string[], headers: Record<string, string> = {}): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Request("https://api.pharos.watch/api/test", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("parseRequestJsonWithSchema bounded JSON parsing", () => {
  it("formats schema failures and preserves response options", async () => {
    const response = await parseRequestJsonWithSchema(
      makeJsonBodyRequest("https://api.pharos.watch/api/test", '{"ok":"yes"}'),
      schema,
      {
        formatSchemaError: (issues) => `Invalid fields: ${issues.map((issue) => issue.path.join(".")).join(", ")}`,
        responseOptions: { noStore: true, headers: { "X-Request-Id": "schema-error" }, retryAfterSec: 7 },
      },
    ) as Response;
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Request-Id")).toBe("schema-error");
    expect(response.headers.get("Retry-After")).toBe("7");
    await expect(response.json()).resolves.toEqual({ error: "Invalid fields: ok" });
  });

  it("counts UTF-8 bytes at the inclusive cap across chunks", async () => {
    const text = '{"ok":true,"pad":"é"}';
    const maxBytes = encoder.encode(text).byteLength;
    await expect(parseRequestJsonWithSchema(streamedRequest([text]), schema, { maxBytes }))
      .resolves.toEqual({ ok: true });
    const response = await parseRequestJsonWithSchema(streamedRequest([text, " "]), schema, { maxBytes }) as Response;
    expect(response.status).toBe(413);
  });

  it("returns 400 for a failed body stream rather than overflow", async () => {
    const request = new Request("https://api.pharos.watch/api/test", {
      method: "POST",
      body: new ReadableStream({ start(controller) { controller.error(new Error("read failed")); } }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await parseRequestJsonWithSchema(request, schema) as Response;
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON body" });
  });

  it("allows an empty optional POST and rejects non-objects without consuming the original", async () => {
    for (const text of ["", "null", "[]"]) {
      const request = makeJsonBodyRequest("https://api.pharos.watch/api/test", text);
      const result = await parseOptionalRequestJsonObject(request);
      if (text === "") expect(result).toEqual({});
      else expect((result as Response).status).toBe(400);
      expect(request.bodyUsed).toBe(false);
      await expect(request.text()).resolves.toBe(text);
    }
  });

  it("accepts valid JSON under the byte cap", async () => {
    await expect(
      parseRequestJsonWithSchema(
        makeJsonBodyRequest("https://api.pharos.watch/api/test", JSON.stringify({ ok: true })),
        schema,
        { maxBytes: 64 },
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("preserves invalid JSON as 400 under the byte cap", async () => {
    const response = await parseRequestJsonWithSchema(
      makeJsonBodyRequest("https://api.pharos.watch/api/test", "{"),
      schema,
      { maxBytes: 64 },
    );

    expect(response).toBeInstanceOf(Response);
    if (response instanceof Response) {
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid JSON body" });
    }
  });

  it("rejects oversized declared Content-Length before reading", async () => {
    const request = makeJsonBodyRequest("https://api.pharos.watch/api/test", JSON.stringify({ ok: true }), {
      headers: { "Content-Length": "65" },
    });
    Object.defineProperty(request, "body", {
      get() { throw new Error("Oversized declared body must not be accessed"); },
    });
    const response = await parseRequestJsonWithSchema(
      request,
      schema,
      { maxBytes: 64 },
    );

    expect(response).toBeInstanceOf(Response);
    if (response instanceof Response) {
      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({ error: "Request body too large" });
    }
  });

  it("rejects oversized chunked bodies without relying on Content-Length", async () => {
    const response = await parseRequestJsonWithSchema(
      streamedRequest(['{"ok":', "true", ',"pad":"', "x".repeat(80), '"}']),
      schema,
      { maxBytes: 64 },
    );

    expect(response).toBeInstanceOf(Response);
    if (response instanceof Response) {
      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({ error: "Request body too large" });
    }
  });

  it("rejects lying-small Content-Length bodies while streaming", async () => {
    const response = await parseRequestJsonWithSchema(
      streamedRequest(['{"ok":true,"pad":"', "x".repeat(80), '"}'], { "Content-Length": "12" }),
      schema,
      { maxBytes: 64 },
    );

    expect(response).toBeInstanceOf(Response);
    if (response instanceof Response) {
      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({ error: "Request body too large" });
    }
  });

  it("applies the default byte cap when callers do not provide one", async () => {
    const response = await parseRequestJsonWithSchema(
      streamedRequest(['{"ok":true,"pad":"', "x".repeat(DEFAULT_REQUEST_JSON_MAX_BYTES), '"}']),
      schema,
    );

    expect(response).toBeInstanceOf(Response);
    if (response instanceof Response) {
      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({ error: "Request body too large" });
    }
  });

  it("bounds optional admin JSON bodies", async () => {
    const response = await parseOptionalRequestJsonObject(
      streamedRequest(['{"pad":"', "x".repeat(DEFAULT_REQUEST_JSON_MAX_BYTES), '"}']),
    );

    expect(response).toBeInstanceOf(Response);
    if (response instanceof Response) {
      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({ error: "Request body too large" });
    }
  });
});
