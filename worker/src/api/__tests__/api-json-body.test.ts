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
    const response = await parseRequestJsonWithSchema(
      makeJsonBodyRequest("https://api.pharos.watch/api/test", JSON.stringify({ ok: true }), {
        headers: { "Content-Length": "65" },
      }),
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
